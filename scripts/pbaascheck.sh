#!/bin/bash

################################################################################
# PBaaS Block Verification and Processing Script
################################################################################
#
# © verus.io 2018-2024, released under MIT license
# Script written in 2023 by Oink.vrsc@
# Script maintained by Oink.vrsc@
#
# DESCRIPTION:
#   This script is a critical component of the Verus mining pool infrastructure
#   that handles PBaaS (Public Blockchains as a Service) block verification and
#   share processing. It performs the following main functions:
#
#   1. Verifies blocks found on PBaaS chains against the main Verus chain
#   2. Processes miner shares for PBaaS rewards
#   3. Manages identity address mappings (i-addresses to R-addresses)
#   4. Maintains Redis database state for pool operations
#   5. Handles share reduction for ongoing mining operations
#
# WORKFLOW:
#   - Check for concurrent execution (prevents multiple instances)
#   - Validate system dependencies and connectivity
#   - Retrieve pending PBaaS blocks from Redis
#   - Cross-reference blocks across all active PBaaS chains
#   - Update Redis with confirmed blocks and associated shares
#   - Process identity address conversions for proper payouts
#   - Reduce worker shares for next cycle
#
# DEPENDENCIES:
#   - verus (Verus blockchain daemon and CLI)
#   - redis-cli or keydb-cli (Redis database client)
#   - bc (arbitrary precision calculator)
#   - jq (JSON processor)
#   - tr (character translator)
#   - cut (text column extractor)
#
# CONFIGURATION:
#   Modify the "default settings" section below to match your environment
#
################################################################################

##==============================================================================
## CONCURRENCY CONTROL
##==============================================================================
# Prevent multiple instances of this script from running simultaneously
# Uses a PID file with timestamp checking to handle stale locks
# Check if script is already running by examining PID file
if [ -f /tmp/pbaascheck.pid ]
then
  # Get the creation time of the PID file (in epoch seconds)
  PID_TIME=$(stat -c '%W' /tmp/pbaascheck.pid)
  # Get current time in epoch seconds
  CUR_TIME=$(date +%s)
  # Calculate age of PID file in seconds
  PID_AGE=$(echo "$CUR_TIME - $PID_TIME" | bc)
  
  # If PID file is less than 1 hour old, assume script is still running
  if [[ $PID_AGE -le 3600 ]]
  then
    echo "script is already running"
    exit 1
  else
    # PID file is older than 1 hour, likely from a crashed instance
    echo "script has apparently aborted before removing /tmp/pbaascheck.pid, continuing"
  fi
else
  # Create PID file to indicate script is running
  touch /tmp/pbaascheck.pid
fi

##==============================================================================
## CONFIGURATION VARIABLES
##==============================================================================
# These settings should be modified to match your specific environment setup

# Payment processor directory - contains pool configuration files
PAYMENT=/home/pool/payment       # Change if you used a different location

# Verus blockchain client binary path
VERUS=/home/verus/bin/verus      # complete path to (and including) the verus RPC client

# Primary blockchain identifier for the main hashing chain
MAIN_CHAIN=VRSC                  # main hashing chain

# Redis database configuration
REDIS_NAME=verus                 # name you assigned the coin in `/home/pool/s-nomp/coins/*.json`
REDIS_HOST=127.0.0.1             # If you run this script on another system, alter the IP address of your Redis server
REDIS_PORT=6379                  # If you use a different REDIS port, alter the port accordingly

##==============================================================================
## ENVIRONMENT SETUP
##==============================================================================
# Determine the absolute path of the script directory for file operations
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

##==============================================================================
## VERUS BINARY VALIDATION
##==============================================================================
# Locate the Verus binary, preferring system PATH over configured location
# First, try to find verus in the system PATH
if ! command -v verus &>/dev/null
then
  echo "verus not found in your PATH environment. Using location from configuration section."
  # Fall back to the configured VERUS path if not found in PATH
  if ! command -v $VERUS &>/dev/null
  then
    echo "Verus could not be found. Make sure it's in your path and/or in the configuration section of this script."
    echo "exiting..."
    exit 1
  fi
else
  # Use the verus binary found in PATH
  VERUS=$(which verus)
fi


##==============================================================================
## SYSTEM DEPENDENCIES VALIDATION
##==============================================================================
# Verify all required system utilities are available and store their paths
# Dependencies: bc, jq, tr, cut, redis-cli/keydb-cli

# Define required tools with their descriptions and variable names
declare -A REQUIRED_TOOLS=(
    ["bc"]="Basic Calculator - used for arithmetic operations (timestamps, share calculations)"
    ["jq"]="JSON Query processor - essential for parsing blockchain RPC responses"
    ["tr"]="Text Replacement utility - used for case conversions and string manipulation"
    ["cut"]="Column extraction utility - used for parsing space-delimited output"
)

# Check each required tool and store its path
for tool in "${!REQUIRED_TOOLS[@]}"; do
    if ! command -v "$tool" &>/dev/null; then
        echo "$tool not found. please install using your package manager."
        echo "Description: ${REQUIRED_TOOLS[$tool]}"
        exit 1
    else
        # Store the tool path in an uppercase variable (BC, JQ, TR, CUT)
        declare "${tool^^}"="$(which "$tool")"
        echo "✓ Found $tool: $(which "$tool")"
    fi
done

# Redis/KeyDB client - critical for database operations (supports either implementation)
# This requires special handling since we support two different clients
echo "Checking for Redis/KeyDB client..."
if ! command -v redis-cli &>/dev/null ; then
    if ! command -v keydb-cli &>/dev/null ; then
       echo "Both redis-cli or keydb-cli not found. Please install one using your package manager."
       echo "Description: Redis/KeyDB client - critical for database operations"
       exit 1
    fi
    # Configure KeyDB client with connection parameters
    REDIS_CLI="$(which keydb-cli) -h $REDIS_HOST -p $REDIS_PORT"
    echo "✓ Found keydb-cli: $(which keydb-cli)"
else
    # Configure Redis client with connection parameters
    REDIS_CLI="$(which redis-cli) -h $REDIS_HOST -p $REDIS_PORT"
    echo "✓ Found redis-cli: $(which redis-cli)"
fi

##==============================================================================
## CONNECTIVITY VALIDATION
##==============================================================================
# Test database connectivity before proceeding with operations
# Verify Redis/KeyDB server is responsive
if [[ "$($REDIS_CLI ping)" != "PONG" ]]
then
  echo "cannot connect to redis server"
  exit 1
fi

# Verify main blockchain daemon is running and connected to network
# Get connection count from main chain daemon to verify it's active
count=$(${VERUS} -chain=$MAIN_CHAIN getconnectioncount 2>/dev/null)
# Use pattern matching to validate the response is a number
case $count in
  ''|*[!0-9]*) DAEMON_ACTIVE=0 ;;  # Empty or non-numeric response = inactive
  *) DAEMON_ACTIVE=1 ;;            # Numeric response = active
esac

# Exit if main chain daemon is not properly connected
if [[ "$DAEMON_ACTIVE" != "1" ]]
then
  echo "$MAIN_CHAIN daemon is not running and connected. Start your $MAIN_CHAIN daemon and wait for it to be connected."
  exit 1
fi

##==============================================================================
## DATA COLLECTION PHASE
##==============================================================================
# Gather all necessary data from Redis and blockchain for processing

# Retrieve list of pending PBaaS block hashes from Redis
# Format: blockhash:additional_data
HASHLIST=$($REDIS_CLI smembers $REDIS_NAME:pbaasPending | $CUT -d' ' -f2-)

# Retrieve current miner share data for PBaaS mining
# This data is used to credit miners when PBaaS blocks are confirmed
SHARELIST=$($REDIS_CLI hgetall $REDIS_NAME:shares:pbaasCurrent| $CUT -d' ' -f2-)

# Query the main chain for all available PBaaS currencies in the ecosystem
# Excludes the main chain itself from the list
PBAAS_CHAINS=$($VERUS -chain=$MAIN_CHAIN listcurrencies '{"systemtype":"pbaas"}' | jq --arg MAIN_CHAIN "${MAIN_CHAIN}" -r '.[].currencydefinition | select (.name != "$MAIN_CHAIN") | .name')

# Determine which PBaaS chains are actually running/active on this system
# Only active chains can be queried for block verification
# Loop through all PBaaS chains and test connectivity
for i in $PBAAS_CHAINS
do
  # Test if this specific chain's daemon is active
  count=$(${VERUS} -chain=$i getconnectioncount 2>/dev/null)
  case $count in
    ''|*[!0-9]*) DAEMON_ACTIVE=0 ;;  # No response or invalid response
    *) DAEMON_ACTIVE=1 ;;            # Valid numeric response
  esac
  
  # Add active chains to our processing list
  if [[ "$DAEMON_ACTIVE" = "1" ]]
  then
    ACTIVE_CHAINS="$ACTIVE_CHAINS $i"
  fi
done

# Remove any instance of the main chain from active chains list
# (it's handled separately and shouldn't be in PBaaS processing)
ACTIVE_CHAINS=$(echo $ACTIVE_CHAINS | sed 's/VRSC//g');

##==============================================================================
## BLOCK VERIFICATION PHASE
##==============================================================================
# Cross-reference each pending hash against all active PBaaS chains
# This determines which chain(s) actually contain each block

# Iterate through each pending block hash
for i in $HASHLIST
do
  # Check this hash against each active PBaaS chain
  for j in $ACTIVE_CHAINS
  do
    # Extract block hash from the Redis entry (first field before ':')
    BLOCK_HASH=$(echo $i | $CUT -d':' -f1)
    
    # Query this PBaaS chain for the block (verbosity=2 for full transaction details)
    CHECK=$($VERUS -chain=$j getblock $BLOCK_HASH 2 2>/dev/null)
    
    # Check if the response contains our target block hash (block found on this chain)
    if [[ "$CHECK" =~ "$BLOCK_HASH"  ]]
    then
      # Extract transaction ID and block height from the block data
      TRANSACTION=$(echo "$CHECK" | $JQ -r '.tx[0].txid')
      BLOCK=$(echo "$CHECK" | $JQ  '.height')
      
      echo "$j contains blockhash $BLOCK_HASH, TXID: $TRANSACTION"
      
      # Construct new Redis entry with transaction and block data
      # Format: blockhash + transaction + : + block + : + original_suffix
      REDIS_NEW_PENDING="${i:0:65}"$TRANSACTION:$BLOCK:"${i:65}"
      
      # Only process non-main chains (avoid duplicate processing of main chain blocks)
      if [[ "$(echo $j | $TR '[:upper:]' '[:lower:]')" != "$(echo $MAIN_CHAIN | $TR '[:upper:]' '[:lower:]')" ]]
      then
        # Add the verified block to this chain's pending blocks list
        $REDIS_CLI sadd $(echo $j | $TR '[:upper:]' '[:lower:]'):blocksPending $REDIS_NEW_PENDING 1>/dev/null
        
        # Check if share data exists for this block round
        SHARES_AVAILABLE="$($REDIS_CLI hgetall $(echo $j | tr '[:upper:]' '[:lower:]'):shares:round$BLOCK)"
        
        # If no shares exist for this round, copy current share data
        # This ensures miners get credited for their work when the block is processed
        if [[ "$SHARES_AVAILABLE" == "" ]]
        then
          $REDIS_CLI hset $(echo $j | tr '[:upper:]' '[:lower:]'):shares:round$BLOCK $SHARELIST 1>/dev/null
        fi
      fi
    fi
  done
done

##==============================================================================
## UNKNOWN HASH MANAGEMENT
##==============================================================================
# Manage hashes that haven't been found on any active PBaaS chain
# Uses a rolling file system to track unknown hashes over time
# TODO: Migrate this to Redis-based storage for better persistence
# Get current list of still-pending hashes (those not found on any chain)
UNKNOWN_HASHLIST=$($REDIS_CLI smembers $REDIS_NAME:pbaasPending | $CUT -d' ' -f2-)

# Process the oldest unknown hash file (4 iterations old)
# If hashes are still unknown after 4 iterations, remove them from Redis
if [ -f $SCRIPT_DIR/unknown_hashlist.4 ]
then
  while read -r LINE
  do
    # If this old unknown hash is still in the current unknown list,
    # it's been unknown for too long - remove it
    if [[ "$UNKNOWN_HASHLIST" == *"$LINE"* ]]
    then
      echo "removing $LINE from REDIS"
      $REDIS_CLI srem $REDIS_NAME:pbaasPending $LINE 1>/dev/null
    fi
  done < $SCRIPT_DIR/unknown_hashlist.4
  # Remove the processed file
  rm $SCRIPT_DIR/unknown_hashlist.4
fi

# Rotate unknown hash files (shift each file up one number)
# This creates a 4-iteration rolling history of unknown hashes
for i in {3..1}
do
  if [ -f $SCRIPT_DIR/unknown_hashlist.$i ]
  then
    mv $SCRIPT_DIR/unknown_hashlist.$i $SCRIPT_DIR/unknown_hashlist.$((i+1))
  fi
done

# Write current unknown hashes to the newest file (iteration 1)
for i in $UNKNOWN_HASHLIST
do
  echo $i >> $SCRIPT_DIR/unknown_hashlist.1
done

##==============================================================================
## IDENTITY ADDRESS PROCESSING
##==============================================================================
# Process i-addresses (identity addresses) for proper payout handling
# Converts i-addresses to R-addresses or marks them as donations

# Process each active PBaaS chain for identity address management
for CHAIN in $ACTIVE_CHAINS
do
  # Convert chain name to lowercase for consistent Redis key naming
  CHAINlc=$(echo $(echo $CHAIN | $TR '[:upper:]' '[:lower:]'))
  
  # Read the invalid address from this chain's configuration file
  # This is used for donations when an identity doesn't exist
  INVALIDADDRESS=$(cat $PAYMENT/pool_configs/$CHAINlc.json | jq -r .invalidAddress)
  
  echo "Processing i-addresses on $CHAIN. $INVALIDADDRESS used for nonexisting IDs"
  
  # Scan Redis for all balance entries, extract unique i-addresses
  # Process: get all keys -> extract every other line -> remove worker suffixes -> filter i-addresses -> unique sort
  ALL_ADDRESSES=$($REDIS_CLI HSCAN $CHAINlc:balances 0 COUNT 50000 | awk '{print $1}' | sed -n 'n;p' | sed 's/\..*//' | grep -e "^i.*" | sort | uniq)
  # Process each unique i-address found in the balances
  while read -r ADDRESS; do
    if [[ $ADDRESS == i* ]]
    then
      I_ADDRESS=$ADDRESS
      BALANCES=
      DONATIONS=
      
      # First check if the identity exists on the current PBaaS chain
      if [[ $($VERUS -chain=$CHAIN getidentity "$I_ADDRESS") ]]
      then
        echo "$I_ADDRESS exists on $CHAIN, no action needed."
      else
        # Identity doesn't exist on current chain, check main chain
        ID_MAINCHAIN=$($VERUS getidentity "$I_ADDRESS")
        
        # Check if the identity exists on the main chain
        if [[ $(echo $ID_MAINCHAIN) == error* ]]
        then
          # Identity doesn't exist on main chain either - treat as donation
          echo "$I_ADDRESS balance is a donation on $CHAIN..."
          
          # Find all balance entries for this i-address (including worker variants)
          DONATION_TMP=$($REDIS_CLI hscan $CHAINlc:balances 0 COUNT 40000 MATCH $ADDRESS* | awk 'NR % 2 == 0')
          
          if ! [ "$DONATION_TMP" == "" ]
          then
            DONATIONS=$DONATIONS$DONATION_TMP" "
            # Process each balance entry for this i-address
            while read OLD_ADDRESS
            do
              BALANCE=0
              NEW_ADDRESS=0
              
              # Split address from worker name (address.worker format)
              tmp=(${OLD_ADDRESS//./ })
              addr=${tmp[0]}
              
              # Replace i-address with invalid address (for donations)
              NEW_ADDRESS=$(echo $OLD_ADDRESS | sed "s/${addr}/${INVALIDADDRESS}/g")
              
              # Transfer the balance from i-address to invalid address
              BALANCE=$($REDIS_CLI HGET $CHAINlc:balances $OLD_ADDRESS)
              $REDIS_CLI HDEL $CHAINlc:balances $OLD_ADDRESS
              $REDIS_CLI HINCBYFLOAT $CHAINlc:balances $NEW_ADDRESS $BALANCE
            done <<<$DONATIONS
          fi
        else
          # Identity exists on main chain - convert i-address to R-address
          # Find all balance entries for this i-address (including worker variants)
          BALANCES_TMP=$($REDIS_CLI hscan $CHAINlc:balances 0 COUNT 40000 MATCH $ADDRESS* | awk 'NR % 2 == 0')
          
          if ! [ "$BALANCES_TMP" == "" ]
          then
            BALANCES=$BALANCES$BALANCES_TMP" "
            
            # Extract the primary R-address from the identity data
            R_ADDRESS=$(echo $ID_MAINCHAIN | jq  -r .identity.primaryaddresses[0])
            
            # Process each balance entry for this i-address
            while read OLD_ADDRESS
            do
              # Split address from worker name (address.worker format)
              tmp=(${OLD_ADDRESS//./ })
              addr=${tmp[0]}
              
              # Replace i-address with corresponding R-address
              NEW_ADDRESS=$(echo $OLD_ADDRESS | sed "s/${addr}/${R_ADDRESS}/g")
              
              # Transfer the balance from i-address to R-address
              BALANCE=$($REDIS_CLI HGET $CHAINlc:balances $OLD_ADDRESS)
              $REDIS_CLI HDEL $CHAINlc:balances $OLD_ADDRESS
              $REDIS_CLI HINCRBYFLOAT $CHAINlc:balances $NEW_ADDRESS $BALANCE
            done <<<$BALANCES
          fi
        fi
      fi
    fi
  done<<<$ALL_ADDRESSES
done

##==============================================================================
## SHARE REDUCTION PHASE
##==============================================================================
# Reduce current PBaaS shares to prevent indefinite accumulation
# This implements a decay mechanism where shares are halved each cycle

WORKERSHAREREDUCTION=

# Retrieve current worker share data from Redis
WORKERSHARES=$($REDIS_CLI HGETALL $REDIS_NAME:shares:pbaasCurrent)

# Process share reduction: remove very small shares, halve larger ones
# This prevents share bloat while maintaining proportional rewards
# Redis HGETALL returns alternating key-value pairs
# We need to track which line is the key (worker address) vs value (share amount)
for LINE in $WORKERSHARES
do
  # Check if this line is a numeric value (share amount)
  if [[ "$LINE" =~ ^[0-9] ]]
  then
    # If share value is less than 2, remove the entire entry
    if [[ "$LINE" < "2.00000000" ]]
    then
      $REDIS_CLI HDEL $REDIS_NAME:shares:pbaasCurrent "$WORKERSHAREREDUCTION"
    else
      # Otherwise, reduce the share value by 50%
      REDUCTION=$(echo "scale=8;$LINE / 2" | $BC)
      $REDIS_CLI HINCRBYFLOAT $REDIS_NAME:shares:pbaasCurrent "$WORKERSHAREREDUCTION" "-$REDUCTION"
    fi
    # Clear the worker address variable for next iteration
    WORKERSHAREREDUCTION=
  else
    # This line is a worker address (key), store it for the next iteration
    WORKERSHAREREDUCTION=$LINE
  fi
done <<<$WORKERSHARES

##==============================================================================
## CLEANUP AND EXIT
##==============================================================================
# Remove the PID file to indicate script completion
# This allows future instances of the script to run
rm /tmp/pbaascheck.pid

################################################################################
# END OF SCRIPT
################################################################################
# Script execution complete. All PBaaS blocks have been verified, shares have
# been processed, identity addresses have been converted, and the database
# state has been updated for the next cycle.
################################################################################

#EOF
