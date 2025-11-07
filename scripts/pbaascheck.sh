#!/usr/bin/env bash

################################################################################
# PBaaS Block Verification and Processing Script (refactored)
#
# Copyright (C) 2025 ComputerGenieCo
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.
#
# - Preserves original behaviour from 2023 script by Oink.vrsc@
# - Improvements: strict mode, safer locking (flock), functions, better
#   command discovery, quoted variables, traps for cleanup, clearer logging.
# - Keep configuration section near the top for easy edits.
#
# Note: This script still depends on the same external tools as before and
# assumes the same Redis key layout and verus RPC API.
################################################################################

set -o errexit
set -o pipefail
set -o nounset
IFS=$'\n\t'

# Configuration (edit if required)
PAYMENT=${PAYMENT:-/home/pool/payment}
VERUS=${VERUS:-/home/verus/bin/verus}
MAIN_CHAIN=${MAIN_CHAIN:-VRSC}
REDIS_NAME=${REDIS_NAME:-verus}
REDIS_HOST=${REDIS_HOST:-127.0.0.1}
REDIS_PORT=${REDIS_PORT:-6379}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

# Lockfile for single instance running using flock on FD 200
LOCKFILE=/var/lock/pbaascheck.lock
exec 200>"$LOCKFILE" || exit 1
if ! flock -n 200; then
  echo "Another instance appears to be running; exiting."
  exit 0
fi

cleanup() {
  # release lock by closing FD 200
  exec 200>&-
}
trap cleanup EXIT INT TERM

log() { printf '%s\n' "$*" >&2; }

find_command_or_fail() {
  local cmd=$1
  if command -v "$cmd" >/dev/null 2>&1; then
    command -v "$cmd"
    return 0
  fi
  return 1
}

# Discover required tools and set wrappers
BC=$(find_command_or_fail bc || { log "bc is required"; exit 1; })
JQ=$(find_command_or_fail jq || { log "jq is required"; exit 1; })
TR=$(find_command_or_fail tr || { log "tr is required"; exit 1; })
CUT=$(find_command_or_fail cut || { log "cut is required"; exit 1; })

# Redis client: prefer redis-cli, fallback to keydb-cli
if command -v redis-cli >/dev/null 2>&1; then
  REDIS_BIN=$(command -v redis-cli)
elif command -v keydb-cli >/dev/null 2>&1; then
  REDIS_BIN=$(command -v keydb-cli)
else
  log "redis-cli or keydb-cli is required"
  exit 1
fi

REDIS_CLI="$REDIS_BIN -h $REDIS_HOST -p $REDIS_PORT"

# Resolve verus binary: prefer PATH, then configured path
if command -v verus >/dev/null 2>&1; then
  VERUS_BIN=$(command -v verus)
elif [ -x "$VERUS" ]; then
  VERUS_BIN=$VERUS
else
  log "verus binary not found in PATH or in VERUS variable ($VERUS)"
  exit 1
fi

# Connectivity checks
if [[ $( $REDIS_CLI ping ) != "PONG" ]]; then
  log "cannot connect to redis server at $REDIS_HOST:$REDIS_PORT"
  exit 1
fi

count=$($VERUS_BIN -chain=$MAIN_CHAIN getconnectioncount 2>/dev/null || true)
if [[ -z "$count" || "$count" =~ [^0-9] ]]; then
  log "$MAIN_CHAIN daemon is not running and connected. Start your $MAIN_CHAIN daemon and wait for it to be connected."
  exit 1
fi

# Helper wrappers for Redis and Verus calls to centralize command execution
redis_cmd() { eval "$REDIS_CLI $*"; }
verus_cmd() { "$VERUS_BIN" "$@"; }

### DATA COLLECTION
HASHLIST=$(redis_cmd smembers "$REDIS_NAME:pbaasPending" | $CUT -d' ' -f2- || true)
SHARELIST=$(redis_cmd hgetall "$REDIS_NAME:shares:pbaasCurrent" | $CUT -d' ' -f2- || true)

# Query for PBaaS chain currencies (exclude main chain)
PBAAS_CHAINS=$(verus_cmd -chain="$MAIN_CHAIN" listcurrencies '{"systemtype":"pbaas"}' | \
  $JQ --arg MAIN_CHAIN "$MAIN_CHAIN" -r '.[].currencydefinition | select(.name != $MAIN_CHAIN) | .name' || true)

# Detect which PBaaS chain daemons are active
ACTIVE_CHAINS=""
for i in $PBAAS_CHAINS; do
  count=$(verus_cmd -chain="$i" getconnectioncount 2>/dev/null || true)
  if [[ -n "$count" && "$count" =~ ^[0-9]+$ ]]; then
    ACTIVE_CHAINS+="$i "
  fi
done

# Remove main chain if present (case-insensitive)
ACTIVE_CHAINS=$(echo "$ACTIVE_CHAINS" | $TR '[:upper:]' '[:lower:]' | sed "s/$(echo $MAIN_CHAIN | $TR '[:upper:]' '[:lower:]')//g" | xargs || true)

### BLOCK VERIFICATION
for entry in $HASHLIST; do
  BLOCK_HASH=$($CUT -d':' -f1 <<<"$entry")
  for chain in $ACTIVE_CHAINS; do
    # Query block with verbosity=2 for transaction array
    CHECK=$(verus_cmd -chain="$chain" getblock "$BLOCK_HASH" 2 2>/dev/null || true)
    if [[ -z "$CHECK" ]]; then
      continue
    fi
    if grep -q "$BLOCK_HASH" <<<"$CHECK"; then
      TRANSACTION=$(printf '%s' "$CHECK" | $JQ -r '.tx[0].txid')
      BLOCK=$(printf '%s' "$CHECK" | $JQ -r '.height')
      log "$chain contains blockhash $BLOCK_HASH, TXID: $TRANSACTION"

      # Reconstruct pending redis entry; preserve original suffix
      PREFIX=${entry:0:65}
      SUFFIX=${entry:65}
      REDIS_NEW_PENDING="${PREFIX}${TRANSACTION}:${BLOCK}:${SUFFIX}"

      # skip main chain
      if [[ "$(echo "$chain" | $TR '[:upper:]' '[:lower:]')" != "$(echo "$MAIN_CHAIN" | $TR '[:upper:]' '[:lower:]')" ]]; then
        redis_cmd sadd "$(echo "$chain" | $TR '[:upper:]' '[:lower:]'):blocksPending" "$REDIS_NEW_PENDING" >/dev/null 2>&1 || true

        SHARES_AVAILABLE=$(redis_cmd hgetall "$(echo "$chain" | $TR '[:upper:]' '[:lower:]'):shares:round$BLOCK" || true)
        if [[ -z "$SHARES_AVAILABLE" ]]; then
          # If no shares exist for round, copy current sharelist (as original did)
          # Use HSET with alternating fields; original used hset with entire string
          # To preserve behavior we write the raw SHARELIST as a single field if SHARELIST non-empty
          if [[ -n "$SHARELIST" ]]; then
            redis_cmd hset "$(echo "$chain" | $TR '[:upper:]' '[:lower:]'):shares:round$BLOCK" $SHARELIST >/dev/null 2>&1 || true
          fi
        fi
      fi
    fi
  done
done

### UNKNOWN HASH MANAGEMENT (rolling files)
UNKNOWN_HASHLIST=$(redis_cmd smembers "$REDIS_NAME:pbaasPending" | $CUT -d' ' -f2- || true)

if [ -f "$SCRIPT_DIR/unknown_hashlist.4" ]; then
  while IFS= read -r LINE; do
    if [[ "$UNKNOWN_HASHLIST" == *"$LINE"* ]]; then
      log "removing $LINE from REDIS"
      redis_cmd srem "$REDIS_NAME:pbaasPending" "$LINE" >/dev/null 2>&1 || true
    fi
  done < "$SCRIPT_DIR/unknown_hashlist.4"
  rm -f "$SCRIPT_DIR/unknown_hashlist.4"
fi

for i in 3 2 1; do
  if [ -f "$SCRIPT_DIR/unknown_hashlist.$i" ]; then
    mv "$SCRIPT_DIR/unknown_hashlist.$i" "$SCRIPT_DIR/unknown_hashlist.$((i+1))"
  fi
done

# write current unknowns
if [[ -n "$UNKNOWN_HASHLIST" ]]; then
  for i in $UNKNOWN_HASHLIST; do
    printf '%s\n' "$i" >> "$SCRIPT_DIR/unknown_hashlist.1"
  done
fi

### IDENTITY ADDRESS PROCESSING
for CHAIN in $ACTIVE_CHAINS; do
  CHAINlc=$(echo "$CHAIN" | $TR '[:upper:]' '[:lower:]')
  cfg="$PAYMENT/pool_configs/$CHAINlc.json"
  if [ ! -f "$cfg" ]; then
    log "Config $cfg missing; skipping $CHAIN"
    continue
  fi
  INVALIDADDRESS=$($JQ -r .invalidAddress "$cfg")
  log "Processing i-addresses on $CHAIN. $INVALIDADDRESS used for nonexisting IDs"

  ALL_ADDRESSES=$(redis_cmd HSCAN "$CHAINlc:balances" 0 COUNT 50000 | awk '{print $1}' | sed -n 'n;p' | sed 's/\..*//' | grep -e '^i' | sort | uniq || true)
  while IFS= read -r ADDRESS; do
    [ -z "$ADDRESS" ] && continue
    if [[ $ADDRESS != i* ]]; then
      continue
    fi

    # Check identity in chain
    if verus_cmd -chain="$CHAIN" getidentity "$ADDRESS" >/dev/null 2>&1; then
      log "$ADDRESS exists on $CHAIN, no action needed."
      continue
    fi

    ID_MAINCHAIN=$(verus_cmd getidentity "$ADDRESS" 2>/dev/null || true)
    if [[ "$ID_MAINCHAIN" == error* || -z "$ID_MAINCHAIN" ]]; then
      # treat as donation
      log "$ADDRESS balance is a donation on $CHAIN..."
      DONATION_TMP=$(redis_cmd hscan "$CHAINlc:balances" 0 COUNT 40000 MATCH "$ADDRESS*" | awk 'NR % 2 == 0' || true)
      if [[ -n "$DONATION_TMP" ]]; then
        while IFS= read -r OLD_ADDRESS; do
          addr=${OLD_ADDRESS%%.*}
          NEW_ADDRESS=${OLD_ADDRESS/$addr/$INVALIDADDRESS}
          BALANCE=$(redis_cmd HGET "$CHAINlc:balances" "$OLD_ADDRESS" || true)
          redis_cmd HDEL "$CHAINlc:balances" "$OLD_ADDRESS" >/dev/null 2>&1 || true
          redis_cmd HINCBYFLOAT "$CHAINlc:balances" "$NEW_ADDRESS" "$BALANCE" >/dev/null 2>&1 || true
        done <<< "$DONATION_TMP"
      fi
    else
      # convert to r-address
      BALANCES_TMP=$(redis_cmd hscan "$CHAINlc:balances" 0 COUNT 40000 MATCH "$ADDRESS*" | awk 'NR % 2 == 0' || true)
      if [[ -n "$BALANCES_TMP" ]]; then
        R_ADDRESS=$(printf '%s' "$ID_MAINCHAIN" | $JQ -r '.identity.primaryaddresses[0]')
        while IFS= read -r OLD_ADDRESS; do
          addr=${OLD_ADDRESS%%.*}
          NEW_ADDRESS=${OLD_ADDRESS/$addr/$R_ADDRESS}
          BALANCE=$(redis_cmd HGET "$CHAINlc:balances" "$OLD_ADDRESS" || true)
          redis_cmd HDEL "$CHAINlc:balances" "$OLD_ADDRESS" >/dev/null 2>&1 || true
          redis_cmd HINCRBYFLOAT "$CHAINlc:balances" "$NEW_ADDRESS" "$BALANCE" >/dev/null 2>&1 || true
        done <<< "$BALANCES_TMP"
      fi
    fi
  done <<< "$ALL_ADDRESSES"
done

### SHARE REDUCTION
WORKERSHARES=$(redis_cmd HGETALL "$REDIS_NAME:shares:pbaasCurrent" || true)
if [[ -n "$WORKERSHARES" ]]; then
  # HGETALL returns alternating key value on separate lines when printed
  # We'll iterate by pairs using a while-read loop
  printf '%s\n' $WORKERSHARES | {
    read -r key || true
    while [ -n "$key" ]; do
      read -r val || true
      if [[ -z "$val" ]]; then
        break
      fi
      # If value less than 2 remove entry else halve it
      # Use bc for floating point math
      cmp=$(printf '%s' "$val < 2.00000000" | $BC -l)
      if [[ "$cmp" -eq 1 ]]; then
        redis_cmd HDEL "$REDIS_NAME:shares:pbaasCurrent" "$key" >/dev/null 2>&1 || true
      else
        REDUCTION=$(printf 'scale=8; %s / 2' "$val" | $BC)
        redis_cmd HINCRBYFLOAT "$REDIS_NAME:shares:pbaasCurrent" "$key" "-$REDUCTION" >/dev/null 2>&1 || true
      fi
      read -r key || break
    done
  }
fi

log "pbaascheck.sh completed"

exit 0

