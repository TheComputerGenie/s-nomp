/**
 * Utilities aggregator
 *
 * @fileoverview Central export that re-exports all utility submodules for
 * compatibility with existing imports.
 * @author ComputerGenieCo
 * @version 21.7.3
 * @license GPL-3.0-or-later
 * @copyright 2025
 */

// Aggregator that re-exports split utility modules to preserve the original
// public API while organizing the implementation into smaller files under `libs/utils/`.

// Requires (alphabetically sorted)
exports.address = require('./address');
exports.crypto = require('./crypto');
exports.encoding = require('./encoding');
exports.misc = require('./misc');
exports.numbers = require('./numbers');
exports.rpc = require('./rpc');
exports.script = require('./script');

// Const aliases (alphabetically sorted)
const a = exports.address;
const c = exports.crypto;
const e = exports.encoding;
const m = exports.misc;
const n = exports.numbers;
const b = exports.rpc;
const s = exports.script;

// Exports grouped by source alias (alphabetically by alias), each group
// has its members sorted alphabetically.

// address (a)
exports.addressFromEx = a.addressFromEx;
exports.base58Decode = a.base58Decode;
exports.bech32Decode = a.bech32Decode;
exports.getVersionByte = a.getVersionByte;
exports.sha256Checksum = a.sha256Checksum;
exports.validateVerusAddress = a.validateVerusAddress;

// crypto (c)
exports.bignum = c.bignum;
exports.bignumFromBitsBuffer = c.bignumFromBitsBuffer;
exports.bignumFromBitsHex = c.bignumFromBitsHex;
exports.bufferToCompactBits = c.bufferToCompactBits;
exports.calculateDifficulty = c.calculateDifficulty;
exports.convertBitsToBuff = c.convertBitsToBuff;
exports.getTruncatedDiff = c.getTruncatedDiff;
exports.sha256 = c.sha256;
exports.sha256d = c.sha256d;

// encoding (e)
exports.hexFromReversedBuffer = e.hexFromReversedBuffer;
exports.reverseBuffer = e.reverseBuffer;
exports.reverseByteOrder = e.reverseByteOrder;
exports.reverseHex = e.reverseHex;
exports.toHex = e.toHex;
exports.uint256BufferFromHash = e.uint256BufferFromHash;

// misc (m)
exports.getReadableHashRateString = m.getReadableHashRateString;
exports.getReadableNetworkHashRateString = m.getReadableNetworkHashRateString;
exports.range = m.range;
exports.safeString = m.safeString;
exports.shiftMax256Right = m.shiftMax256Right;

// numbers (n)
exports.packInt32BE = n.packInt32BE;
exports.packInt32LE = n.packInt32LE;
exports.packInt64LE = n.packInt64LE;
exports.packUInt16LE = n.packUInt16LE;
exports.packUInt32BE = n.packUInt32BE;
exports.packUInt32LE = n.packUInt32LE;
exports.serializeNumber = n.serializeNumber;
exports.serializeString = n.serializeString;
exports.varIntBuffer = n.varIntBuffer;
exports.varStringBuffer = n.varStringBuffer;

// rpc (b)
exports.checkBlockAccepted = b.checkBlockAccepted;
exports.getBlockTemplate = b.getBlockTemplate;
exports.submitBlock = b.submitBlock;

// script (s)
// New script helper exports (P2PKH / P2SH)
exports.miningKeyToScript = s.miningKeyToScript;
exports.addressToScript = s.addressToScript;
exports.pubkeyToScript = s.pubkeyToScript;
exports.scriptCompile = s.scriptCompile;
exports.scriptFoundersCompile = s.scriptFoundersCompile;
