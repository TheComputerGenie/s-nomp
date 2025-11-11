/**
 * @fileoverview Admin panel client-side functionality for s-nomp mining pool software.
 * This file handles authentication, cookie management, and UI interactions for the administrative interface.
 * It provides secure access to pool management functions through password-based authentication.
 *
 * @author s-nomp Contributors
 * @version 1.0.0
 * @requires jQuery - For DOM manipulation and event handling
 */

/**
 * @namespace docCookies
 * @description Cookie management utility object that provides methods for reading, writing, and managing browser cookies.
 * This implementation follows the Mozilla Developer Network cookie handling patterns with proper encoding/decoding.
 * Used primarily for storing and retrieving the admin password for session persistence.
 */
const docCookies = {
    /**
     * Retrieves a cookie value by its key name.
     * @function getItem
     * @memberof docCookies
     * @param {string} sKey - The name of the cookie to retrieve
     * @returns {string|null} The decoded cookie value, or null if the cookie doesn't exist
     * @example
     * // Get the stored password
     * const password = docCookies.getItem('password');
     */
    getItem: function (sKey) {
        // Use regex to extract cookie value, handling proper encoding and multiple cookies
        return decodeURIComponent(document.cookie.replace(new RegExp(`(?:(?:^|.*;)\\s*${encodeURIComponent(sKey).replace(/[\-\.\+\*]/g, '\\$&')}\\s*\\=\\s*([^;]*).*$)|^.*$`), '$1')) || null;
    },
    /**
     * Sets a cookie with the specified parameters.
     * @function setItem
     * @memberof docCookies
     * @param {string} sKey - The name of the cookie to set
     * @param {string} sValue - The value to store in the cookie
     * @param {number|string|Date} [vEnd] - Expiration time (Number for max-age in seconds, String for expires date, Date object, or Infinity for persistent)
     * @param {string} [sPath] - The path where the cookie is accessible
     * @param {string} [sDomain] - The domain where the cookie is accessible
     * @param {boolean} [bSecure] - Whether the cookie should only be sent over HTTPS
     * @returns {boolean} True if the cookie was set successfully, false otherwise
     * @example
     * // Set a session cookie
     * docCookies.setItem('password', 'mypassword');
     * // Set a persistent cookie
     * docCookies.setItem('password', 'mypassword', Infinity);
     */
    setItem: function (sKey, sValue, vEnd, sPath, sDomain, bSecure) {
        // Validate key name - reject reserved cookie attribute names
        if (!sKey || /^(?:expires|max\-age|path|domain|secure)$/i.test(sKey)) {
            return false;
        }
        let sExpires = '';
        // Handle different expiration formats
        if (vEnd) {
            switch (vEnd.constructor) {
                case Number:
                    // Infinity sets far future date, otherwise use max-age
                    sExpires = vEnd === Infinity ? '; expires=Fri, 31 Dec 9999 23:59:59 GMT' : `; max-age=${vEnd}`;
                    break;
                case String:
                    // Direct expires string
                    sExpires = `; expires=${vEnd}`;
                    break;
                case Date:
                    // Convert Date object to UTC string
                    sExpires = `; expires=${vEnd.toUTCString()}`;
                    break;
            }
        }
        // Construct and set the cookie with proper encoding
        document.cookie = `${encodeURIComponent(sKey)}=${encodeURIComponent(sValue)}${sExpires}${sDomain ? `; domain=${sDomain}` : ''}${sPath ? `; path=${sPath}` : ''}${bSecure ? '; secure' : ''}`;
        return true;
    },
    /**
     * Removes a cookie by setting its expiration date to the past.
     * @function removeItem
     * @memberof docCookies
     * @param {string} sKey - The name of the cookie to remove
     * @param {string} [sPath] - The path where the cookie was set (must match for removal)
     * @param {string} [sDomain] - The domain where the cookie was set (must match for removal)
     * @returns {boolean} True if the cookie was removed successfully, false if it didn't exist
     * @example
     * // Remove the password cookie
     * docCookies.removeItem('password');
     */
    removeItem: function (sKey, sPath, sDomain) {
        // Check if key exists and cookie is present
        if (!sKey || !this.hasItem(sKey)) {
            return false;
        }
        // Set expiration to past date (epoch) to remove the cookie
        document.cookie = `${encodeURIComponent(sKey)}=; expires=Thu, 01 Jan 1970 00:00:00 GMT${sDomain ? `; domain=${sDomain}` : ''}${sPath ? `; path=${sPath}` : ''}`;
        return true;
    },
    /**
     * Checks if a cookie with the specified key exists.
     * @function hasItem
     * @memberof docCookies
     * @param {string} sKey - The name of the cookie to check for
     * @returns {boolean} True if the cookie exists, false otherwise
     * @example
     * // Check if password is stored
     * if (docCookies.hasItem('password')) {
     *     // Password exists in cookies
     * }
     */
    hasItem: function (sKey) {
        // Use regex to test if cookie name exists in document.cookie
        return (new RegExp(`(?:^|;\\s*)${encodeURIComponent(sKey).replace(/[\-\.\+\*]/g, '\\$&')}\\s*\\=`)).test(document.cookie);
    }
};

/**
 * Global variable to store the current admin password.
 * Retrieved from cookies on page load and used for API authentication.
 * @type {string|null}
 */
let password = docCookies.getItem('password');

/**
 * Shows the login form and hides the admin center interface.
 * This function is called when the user needs to authenticate or when authentication fails.
 * @function showLogin
 * @example
 * // Show login when authentication fails
 * showLogin();
 */
function showLogin() {
    // Hide the main admin interface
    $('#adminCenter').hide();
    // Show the password input form
    $('#passwordForm').show();
}

/**
 * Shows the admin center interface and hides the login form.
 * This function is called after successful authentication to display the main admin panel.
 * @function showAdminCenter
 * @example
 * // Show admin center after successful login
 * showAdminCenter();
 */
function showAdminCenter() {
    // Hide the password input form
    $('#passwordForm').hide();
    // Show the main admin interface
    $('#adminCenter').show();
}

/**
 * Attempts to authenticate with the stored password by making a test API request.
 * On successful authentication, shows the admin center and displays the pool menu.
 * On failure, the apiRequest function will handle showing the login form.
 * @function tryLogin
 * @example
 * // Try to log in with stored password
 * tryLogin();
 */
function tryLogin() {
    // Make a test API request to 'pools' endpoint to verify authentication
    apiRequest('pools', {}, (response) => {
        // If successful, show the admin interface
        showAdminCenter();
        // Populate the menu with available pools
        displayMenu(response.result);
    });
}

/**
 * Displays the pool menu by creating list items for each available pool.
 * The menu is inserted after the #poolList element and contains clickable links for each pool.
 * @function displayMenu
 * @param {Object} pools - Object containing pool configurations, where keys are pool names
 * @example
 * // Display menu for multiple pools
 * displayMenu({ 'bitcoin': {...}, 'litecoin': {...} });
 */
function displayMenu(pools) {
    // Extract pool names and create HTML list items
    $('#poolList').after(Object.keys(pools).map((poolName) => {
        // Create a list item with a link for each pool
        return `<a href="#" class="list-group-item list-group-item-action poolMenuItem">${poolName}</a>`;
    }).join('')); // Join all list items into a single HTML string
}

/**
 * Makes authenticated API requests to the admin endpoints.
 * Automatically includes the current password in the request data for authentication.
 * Handles authentication failures by clearing stored credentials and showing login form.
 * @function apiRequest
 * @param {string} func - The API function/endpoint to call (e.g., 'pools', 'stats')
 * @param {Object} data - Additional data to send with the request
 * @param {Function} callback - Callback function to execute on successful response
 * @example
 * // Get pool information
 * apiRequest('pools', {}, (response) => {
 *     console.log('Pools:', response.result);
 * });
 *
 * // Send command with additional data
 * apiRequest('restart', { poolName: 'bitcoin' }, (response) => {
 *     console.log('Command result:', response);
 * });
 */
function apiRequest(func, data, callback) {
    // Create new XMLHttpRequest for API communication
    const httpRequest = new XMLHttpRequest();

    // Set up response handler
    httpRequest.onreadystatechange = function () {
        // Check if request is complete and has response text
        if (httpRequest.readyState === 4 && httpRequest.responseText) {
            // Handle authentication failure (401 Unauthorized)
            if (httpRequest.status === 401) {
                // Clear stored password from cookies
                docCookies.removeItem('password');
                // Clear password input field
                $('#password').val('');
                // Show login form
                showLogin();
                // Alert user of authentication failure
                alert('Incorrect Password');
            } else {
                // Parse successful response and execute callback
                const response = JSON.parse(httpRequest.responseText);
                callback(response);
            }
        }
    };

    // Configure the POST request to admin API endpoint
    httpRequest.open('POST', `/api/admin/${func}`);
    // Add current password to request data for authentication
    data.password = password;
    // Set content type for JSON data
    httpRequest.setRequestHeader('Content-Type', 'application/json');
    // Send the request with JSON-encoded data
    httpRequest.send(JSON.stringify(data));
}

/**
 * Application initialization logic.
 * Checks if a password is stored in cookies and attempts automatic login,
 * otherwise shows the login form.
 */
if (password) {
    // Password found in cookies, attempt automatic login
    tryLogin();
} else {
    // No stored password, show login form
    showLogin();
}

/**
 * Password form submission handler.
 * Handles user login attempts by storing the password (optionally persistent)
 * and attempting authentication with the server.
 */
$('#passwordForm').submit((event) => {
    // Prevent default form submission behavior
    event.preventDefault();

    // Get the entered password value
    password = $('#password').val();

    if (password) {
        // Check if user wants to remember the password
        if ($('#remember').is(':checked')) {
            // Store password persistently (until manually cleared)
            docCookies.setItem('password', password, Infinity);
        } else {
            // Store password for session only (cleared when browser closes)
            docCookies.setItem('password', password);
        }

        // Attempt login with the provided password
        tryLogin();
    }

    // Ensure form doesn't submit normally
    return false;
});
