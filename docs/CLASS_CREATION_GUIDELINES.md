# CLASS CREATION GUIDELINES FOR NEW FILES

## Overview
This guide provides instructions for creating new JavaScript files using modern ES6 class structures with proper encapsulation, private fields, and methods. The target style follows the project's refactored class pattern, emphasizing inheritance, encapsulation, and modularity. This ensures consistency across the codebase and leverages modern JavaScript features for better maintainability.

## Key Principles
- Use ES6 `class` syntax for all new class definitions.
- Extend base classes (e.g., `EventEmitter`) when event handling is needed.
- Use private fields (`#field`) for internal state to prevent external access.
- Encapsulate helper functions as private methods (`#method`) within the class.
- Maintain clear public APIs through instance methods and properties.
- Follow JSDoc guidelines for documentation.
- Ensure backward compatibility where required by the API.

## File Structure
- Start with a fileoverview JSDoc header at line 1.
- List all `require()` statements immediately after, alphabetized by module specifier.
- Define the class with comprehensive JSDoc.
- End with `module.exports = ClassName;`.

## Conversion Steps (Adapted for New Files)

### 1. Plan the Module Structure
- Determine if the module needs to emit events (extend `EventEmitter`).
- Identify public API requirements.
- Plan private state and helper functions.

### 2. Define the Class
- Use `class ClassName extends BaseClass` syntax.
- Call `super()` in constructor if extending.
- Example:
  ```javascript
  class MyService extends events.EventEmitter {
      constructor(options) {
          super();
          this.options = options;
      }
  }
  ```

### 3. Encapsulate Internal State
- Use private fields for all internal state.
- Initialize in the constructor or as field initializers.
- Example:
  ```javascript
  class MyService {
      #internalState = null;
      #counter = 0;

      constructor() {
          // Private fields initialized above
      }
  }
  ```

### 4. Implement Helper Functions as Private Methods
- Define helper logic as private methods within the class.
- Use `#methodName` syntax.
- Example:
  ```javascript
  class MyService {
      #helper(param) {
          return param * 2;
      }

      constructor() {
          this.value = this.#helper(5);
      }
  }
  ```

### 5. Define Public Instance Methods
- Implement public methods for the API.
- Use private fields/methods internally.
- Example:
  ```javascript
  class MyService {
      #internalState = 'default';

      process(data) {
          return this.#internalState + data;
      }
  }
  ```

### 6. Handle Static Methods and Properties (if needed)
- Use `static` for class-level methods.
- Ensure they don't rely on instance state.
- Example:
  ```javascript
  class MyService {
      static create(options) {
          return new MyService(options);
      }
  }
  ```

### 7. Implement Event Handling
- If extending `EventEmitter`, use `this.emit()` for events.
- Document all emitted events in class JSDoc.
- Example:
  ```javascript
  class MyService extends events.EventEmitter {
      someMethod() {
          this.emit('event', data);
      }
  }
  ```

### 8. Maintain API Compatibility
- Design public methods and properties for external use.
- Use getters/setters for computed properties if needed.
- Export the class as `module.exports = ClassName;`.

### 9. JSDoc Documentation
- Follow the project's JSDoc guidelines.
- Include fileoverview, class-level, and method-level documentation.
- Document constructor parameters, emitted events, and method signatures.

## Common Patterns

### Async Operations
- Use async/await for asynchronous methods.
- Return Promises for compatibility.

### Error Handling
- Use consistent error handling patterns.
- Emit error events if appropriate.

### Inheritance
- Extend existing classes when building on established functionality.

## Example: Creating a New Service Class

```javascript
/**
 * @fileoverview MyService - Example service class
 *
 * Provides example functionality for demonstration.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
'use strict';

const events = require('events');

class MyService extends events.EventEmitter {
    #internalCounter = 0;

    /**
     * MyService
     *
     * Example service that demonstrates class creation patterns.
     *
     * Events emitted:
     * - 'processed' (result) - When processing is complete
     *
     * @class MyService
     * @extends events.EventEmitter
     * @param {Object} options - Configuration options
     * @param {string} options.name - Service name
     */
    constructor(options) {
        super();
        this.options = options;
        this.publicData = 'public';
    }

    /**
     * Helper method for internal calculations.
     * @param {number} value - Input value
     * @returns {number} Doubled value
     */
    #calculate(value) {
        return value * 2;
    }

    /**
     * Processes input data.
     * @param {string} data - Data to process
     * @returns {string} Processed result
     */
    process(data) {
        this.#internalCounter++;
        const result = this.#calculate(this.#internalCounter) + data;
        this.emit('processed', result);
        return result;
    }

    /**
     * Gets the current counter value.
     * @returns {number} Counter value
     */
    getCounter() {
        return this.#internalCounter;
    }
}

module.exports = MyService;
```

## Tools and Automation
- Use this guide as a template for new class files.
- Ensure all new classes follow these patterns for consistency.
- Test new classes thoroughly before integration.

## Notes
- Private fields/methods require Node.js 12+ or modern JS environments.
- This approach improves maintainability and follows modern JS best practices.
- Always include comprehensive JSDoc documentation from the start.
