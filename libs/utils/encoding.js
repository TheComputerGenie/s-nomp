/**
 * Encoding utilities
 *
 * @fileoverview Byte/hex/endianness helper functions.
 * @author ComputerGenieCo
 * @version 21.7.3
 * @license GPL-3.0-or-later
 * @copyright 2025
 */

exports.toHex = arrayOfBytes => {
    let hex = '';
    for (let i = 0; i < arrayOfBytes.length; i++) {
        const byte = arrayOfBytes[i];
        hex += (byte < 16 ? '0' : '') + byte.toString(16);
    }
    return hex;
};

exports.reverseBuffer = buff => {
    const reversed = Buffer.alloc(buff.length);
    for (let i = buff.length - 1; i >= 0; i--) {
        reversed[buff.length - i - 1] = buff[i];
    }

    return reversed;
};

exports.reverseHex = hex => {
    return exports.reverseBuffer(Buffer.from(hex, 'hex')).toString('hex');
};

exports.reverseByteOrder = buff => {
    for (let i = 0; i < 8; i++) {
        buff.writeUInt32LE(buff.readUInt32BE(i * 4), i * 4);
    }

    return exports.reverseBuffer(buff);
};

exports.uint256BufferFromHash = hex => {
    let fromHex = Buffer.from(hex, 'hex');

    if (fromHex.length != 32) {
        const empty = Buffer.alloc(32);
        empty.fill(0);
        fromHex.copy(empty);
        fromHex = empty;
    }

    return exports.reverseBuffer(fromHex);
};

exports.hexFromReversedBuffer = buffer => {
    return exports.reverseBuffer(buffer).toString('hex');
};
