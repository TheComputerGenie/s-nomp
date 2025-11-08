/**
 * @fileoverview UTXO utilities - shared helpers for utxo modules
 *
 * Small shared utilities used across the utxo folder. Currently exports the
 * project's lightweight `typeforce` replacement used for runtime argument
 * validation in multiple modules.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

/**
 * Lightweight runtime validator used by utxo modules.
 *
 * Accepts either a validator function or an array of validators. When given a
 * function it will run the function with the provided value (a special-case
 * converts an "arguments" object to an array). When given an array it will
 * validate each corresponding element recursively.
 *
 * @param {(Function|Array)} validator - A predicate function that returns
 *   truthy when the value is valid, or an array of validators for positional
 *   arguments validation.
 * @param {*} value - The value to validate. May be an arguments-like object,
 *   in which case it will be converted to a real Array for validation.
 * @returns {*} The original value when validation succeeds.
 * @throws {TypeError} When validation fails, with a short message indicating
 *   the expected type.
 */
function typeforce(validator, value) {
    if (typeof validator === 'function') {
        // Convert arguments object to array if needed (but not Buffers or other objects with length)
        let testValue = value;
        if (value && typeof value === 'object' && typeof value.length === 'number' &&
            !Array.isArray(value) && !Buffer.isBuffer(value) &&
            Object.prototype.toString.call(value) === '[object Arguments]') {
            testValue = Array.prototype.slice.call(value);
        }

        if (!validator(testValue)) {
            throw new TypeError(`Expected ${validator.name || 'valid type'}`);
        }
    } else if (Array.isArray(validator)) {
        if (!Array.isArray(value)) {
            throw new TypeError('Expected array');
        }
        for (let i = 0; i < validator.length && i < value.length; i++) {
            typeforce(validator[i], value[i]);
        }
    }
    return value;
}

module.exports = {
    typeforce
};
