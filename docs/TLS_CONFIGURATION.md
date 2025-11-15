# TLS Configuration for Coin Daemons

**Note:** The `tlsOptions` in the pool configuration enable TLS for stratum mining connections (miners connecting to the pool) and P2P peer connections (connecting to coin daemons via P2P protocol). This provides secure, encrypted communication for mining operations and peer networking. Daemon RPC connections remain over unencrypted HTTP, as VerusCoin and its child chains do not support TLS for RPC.

If you encounter debug output resembling TLS handshake details (e.g., "tlsv = TLSv1.3 ... Using cipher: TLS_AES_256_GCM_SHA384"), this originates from the stratum mining connections or P2P peer connections enabled via `tlsOptions`, not from daemon RPC.

To enable TLS for miner connections and P2P peer connections, follow the steps below to generate self-signed certificates.

## Prerequisites
- OpenSSL installed on your system (available on most Linux distributions via package manager, e.g., `sudo apt install openssl` on Ubuntu).
- Basic knowledge of command-line operations.

## Steps to Generate Self-Signed Certificates
1. Create a directory to store the certificates (e.g., `/path/to/certs`).
2. Generate a private key:
   ```
   openssl genrsa -out server-key.pem 2048
   ```
3. Generate a certificate signing request (CSR). You will be prompted for certificate details (e.g., country, organization). The Common Name (CN) should be your pool's domain or IP address.
   ```
   openssl req -new -key server-key.pem -out server-csr.pem
   ```
4. Generate the self-signed certificate:
   ```
   openssl x509 -req -in server-csr.pem -signkey server-key.pem -out server-cert.pem -days 365
   ```
5. (Optional) Verify the certificate:
   ```
   openssl x509 -in server-cert.pem -text -noout
   ```

## File Locations
- `serverKey`: Path to `server-key.pem` (e.g., `/path/to/certs/server-key.pem` or `certs/server-key.pem` relative to the app's root directory)
- `serverCert`: Path to `server-cert.pem` (e.g., `/path/to/certs/server-cert.pem` or `certs/server-cert.pem` relative to the app's root directory)
- `ca`: For self-signed certificates, use the same path as `serverCert` (e.g., `/path/to/certs/server-cert.pem` or `certs/server-cert.pem` relative to the app's root directory)

**Note:** Certificate paths can be absolute or relative to the application's root directory (where `init.js` is located).

## Configuring TLS in Pool Config
In your pool configuration JSON file (e.g., `pool_configs/vrsc.json`), update the `tlsOptions` section:

```json
"tlsOptions": {
    "enabled": true,
    "serverKey": "/path/to/certs/server-key.pem",
    "serverCert": "/path/to/certs/server-cert.pem",
    "ca": "/path/to/certs/server-cert.pem",
    "rejectUnauthorized": false
}
```

Alternatively, using paths relative to the app's root directory:

```json
"tlsOptions": {
    "enabled": true,
    "serverKey": "certs/server-key.pem",
    "serverCert": "certs/server-cert.pem",
    "ca": "certs/server-cert.pem",
    "rejectUnauthorized": false
}
```

## Important Notes
- Self-signed certificates will cause warnings in miners' software, as they are not trusted by default. Miners may need to configure their software to accept self-signed certificates or add the CA to their trust store.
- For production use, consider obtaining certificates from a trusted Certificate Authority (CA) to avoid security warnings.
- Ensure the certificate files are readable by the v-nomp process and secure (e.g., restrict permissions with `chmod 600`).
- If using a domain name, ensure the certificate's Common Name matches the domain used by miners.
- **For self-signed certificates**: Always set the `ca` field to the same path as `serverCert` and set `"rejectUnauthorized": false` to accept self-signed certificates without strict verification. If you encounter the error `DEPTH_ZERO_SELF_SIGNED_CERT`, ensure `rejectUnauthorized` is set to `false`.
- **Certificate Validation**: The application validates certificate files at startup. Ensure all paths are correct and files exist before enabling TLS.
- **P2P TLS Requirements**: For P2P peer connections to use TLS, the coin daemon must support TLS-encrypted P2P connections and be configured with the same certificates. Consult your coin's documentation for enabling TLS on the daemon's P2P port. The daemon must use the same `server-key.pem` and `server-cert.pem` files generated above.