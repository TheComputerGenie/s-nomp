/**
 * @file blocknotify.c
 * @brief High-performance block notification client for NOMP mining pools
 * 
 * This is a lightweight, efficient block notification script written in pure C
 * that sends block discovery notifications to NOMP (Node Open Mining Portal) pools.
 * It establishes a TCP connection to the pool's CLI interface and sends a JSON
 * command when a new block is discovered.
 * 
 * @author Alex Petrov (SysMan) <sysman.net>
 * @author Alejandro Reyero (TodoJuegos.com) - Updates and improvements
 * @version 1.0
 * @date 2025
 * 
 * @section DESCRIPTION
 * Part of the NOMP project - a Node.js based mining pool solution.
 * This C implementation provides better performance compared to script-based
 * block notification methods, reducing latency in block discovery notifications.
 * 
 * The program can also potentially work as a coin switching notification mechanism.
 * 
 * @section PLATFORMS
 * Supported platforms: Linux, BSD, Solaris (mostly OS independent)
 * 
 * @section COMPILATION
 * Build with: gcc blocknotify.c -o blocknotify
 * 
 * @section USAGE
 * Command line usage: blocknotify <host:port> <coin> <block_hash>
 * 
 * Example daemon configuration (coin.conf) using default NOMP CLI port 17117:
 * blocknotify="/bin/blocknotify 127.0.0.1:17117 dogecoin %s"
 * 
 * @section PROTOCOL
 * Sends JSON command over TCP:
 * {"command":"blocknotify","params":["<coin>","<block_hash>"]}
 */

/* System includes for network operations */
#include <sys/socket.h>    /* Socket functions and data structures */
#include <netinet/in.h>    /* Internet address family */
#include <arpa/inet.h>     /* Internet address manipulation functions */
#include <stdio.h>         /* Standard I/O functions */
#include <unistd.h>        /* UNIX standard definitions */
#include <stdlib.h>        /* Standard library functions */
#include <string.h>        /* String manipulation functions */
#include <errno.h>         /* Error number definitions */


/**
 * @brief Main entry point for the block notification client
 * 
 * Parses command line arguments, establishes TCP connection to NOMP pool,
 * and sends block notification in JSON format.
 * 
 * @param argc Number of command line arguments (should be 4: program, host:port, coin, block)
 * @param argv Array of command line argument strings
 *             argv[0] - Program name
 *             argv[1] - Host and port in format "host:port" (e.g., "127.0.0.1:17117")
 *             argv[2] - Coin identifier (e.g., "dogecoin", "bitcoin")
 *             argv[3] - Block hash to notify about
 * 
 * @return 0 on success, -1 on network error, 1 on invalid arguments
 * 
 * @section FLOW
 * 1. Validate command line arguments
 * 2. Parse host:port from first argument
 * 3. Create JSON notification message
 * 4. Establish TCP connection to pool
 * 5. Send notification and close connection
 * 
 * @section ERRORS
 * - Exit code 1: Invalid number of arguments
 * - Exit code -1: Network send error
 * - stderr output: Port parsing errors
 */
int main(int argc, char **argv)
{
    /* Network connection variables */
    int sockfd;                         /**< Socket file descriptor */
    struct sockaddr_in servaddr;       /**< Server address structure for TCP connection */
    
    /* Communication buffers */
    char sendline[1000];                /**< Buffer for outgoing JSON message (max 1000 chars) */
    
    /* Host/Port parsing variables */
    char host[200];                     /**< Buffer to store hostname/IP address (max 200 chars) */
    char *p, *arg, *errptr;            /**< Pointers for string parsing and error checking */
    int port;                          /**< Parsed port number for TCP connection */

    /* 
     * Validate command line arguments
     * We need exactly 4 arguments: program name + 3 parameters
     * argc[0] = program name, argc[1] = host:port, argc[2] = coin, argc[3] = block_hash
     */
    if (argc < 4)
    {
        /* Display usage information and exit with error code */
        printf("NOMP pool block notify\n usage: <host:port> <coin> <block>\n");
        printf("Example: blocknotify 127.0.0.1:17117 dogecoin abc123def456\n");
        exit(1);
    }

    /*
     * Validate coin and block hash parameters
     * Basic validation to ensure they're not empty
     */
    if (strlen(argv[2]) == 0) {
        fprintf(stderr, "Error: Coin parameter cannot be empty\n");
        exit(1);
    }
    
    if (strlen(argv[3]) == 0) {
        fprintf(stderr, "Error: Block hash parameter cannot be empty\n");
        exit(1);
    }

    /*
     * Parse host:port from first argument
     * Copy the host:port string safely to avoid buffer overflow
     */
    strncpy(host, argv[1], (sizeof(host)-1));
    host[sizeof(host)-1] = '\0';  /* Ensure null termination */
    p = host;  /* Point to the beginning of the copied string */

    /*
     * Search for colon separator between host and port
     * strchr returns pointer to first occurrence of ':' or NULL if not found
     */
    if ( (arg = strchr(p,':')) )
    {
        /*
         * Split the string at the colon by replacing ':' with null terminator
         * Now 'host' contains just the hostname/IP, 'arg+1' points to port string
         */
        *arg = '\0';

        /*
         * Parse port number from string to integer
         * Reset errno before strtol to detect conversion errors
         */
        errno = 0;
        port = strtol(++arg, &errptr, 10);  /* Base 10 conversion, ++arg skips the ':' */

        /*
         * Validate port number conversion
         * errno != 0: conversion error (overflow, underflow, etc.)
         * errptr == arg: no digits were found
         * port <= 0 or port > 65535: invalid port range
         */
        if ( (errno != 0) || (errptr == arg) || (port <= 0) || (port > 65535) )
        {
            fprintf(stderr, "Error: Invalid port number [%s]. Port must be 1-65535.\n", arg);
            exit(1);
        }
    }
    else
    {
        /*
         * No colon found - invalid format
         * host:port format is required
         */
        fprintf(stderr, "Error: Invalid host:port format. Expected format: host:port\n");
        printf("Example: 127.0.0.1:17117\n");
        exit(1);
    }

	/*
	 * Create JSON-formatted block notification message
	 * Format: {"command":"blocknotify","params":["<coin>","<block_hash>"]}
	 * argv[2] = coin identifier, argv[3] = block hash
	 * 
	 * Check if the resulting message would fit in our buffer
	 * Base JSON structure is about 50 characters, plus coin and block hash lengths
	 */
	size_t estimated_size = 60 + strlen(argv[2]) + strlen(argv[3]);
	if (estimated_size >= sizeof(sendline)) {
		fprintf(stderr, "Error: Coin name and block hash too long (max combined length: %zu chars)\n", 
				sizeof(sendline) - 60);
		exit(1);
	}
	
	/*
	 * Create the JSON message with proper bounds checking
	 * snprintf automatically null-terminates and prevents buffer overflow
	 */
	int msg_len = snprintf(sendline, sizeof(sendline), 
						   "{\"command\":\"blocknotify\",\"params\":[\"%s\",\"%s\"]}\n", 
						   argv[2], argv[3]);
	
	if (msg_len >= (int)sizeof(sendline)) {
		fprintf(stderr, "Error: JSON message truncated (buffer too small)\n");
		exit(1);
	}

	/*
	 * Establish TCP connection to NOMP pool
	 * Step 1: Create TCP socket using IPv4 address family
	 */
	sockfd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	if (sockfd < 0)
	{
		fprintf(stderr, "Error: Failed to create socket: %s\n", strerror(errno));
		exit(1);
	}
	
	/*
	 * Step 2: Configure server address structure
	 * Zero out the structure to ensure clean initialization
	 */
	bzero(&servaddr, sizeof(servaddr));
	servaddr.sin_family = AF_INET;                    /* IPv4 address family */
	
	/*
	 * Convert IP string to binary format
	 * inet_addr returns INADDR_NONE on error
	 */
	servaddr.sin_addr.s_addr = inet_addr(host);
	if (servaddr.sin_addr.s_addr == INADDR_NONE)
	{
		fprintf(stderr, "Error: Invalid IP address format: %s\n", host);
		close(sockfd);
		exit(1);
	}
	
	servaddr.sin_port = htons(port);                  /* Convert port to network byte order */
	
	/*
	 * Step 3: Establish connection to the server
	 * Check for connection errors and provide meaningful error messages
	 */
	if (connect(sockfd, (struct sockaddr *)&servaddr, sizeof(servaddr)) < 0)
	{
		fprintf(stderr, "Error: Failed to connect to %s:%d - %s\n", host, port, strerror(errno));
		close(sockfd);
		exit(1);
	}

	/*
	 * Send the JSON notification message over the established TCP connection
	 * send() returns number of bytes sent, or -1 on error
	 * Parameters:
	 * - sockfd: socket file descriptor
	 * - sendline: pointer to message buffer
	 * - strlen(sendline): number of bytes to send
	 * - 0: no special flags
	 */
	int result = send(sockfd, sendline, strlen(sendline), 0);
	
	/*
	 * Clean up: Close the socket connection
	 * This should be done regardless of send() success/failure
	 */
	close(sockfd);

	/*
	 * Check for send operation errors
	 * -1 indicates a network error occurred
	 */
	if(result == -1) {
		fprintf(stderr, "Error: Failed to send notification - %s\n", strerror(errno));
        exit(-1);  /* Exit with error code -1 */
	}
	else if (result == 0) {
		fprintf(stderr, "Warning: Connection closed by peer before sending data\n");
		exit(-1);
	}
	else if (result != (int)strlen(sendline)) {
		fprintf(stderr, "Warning: Partial send - sent %d of %zu bytes\n", result, strlen(sendline));
		/* Continue anyway as some data was sent */
	}
	
	/*
	 * Success: Block notification sent successfully
	 * Exit with code 0 to indicate successful operation
	 */
	exit(0);
}
