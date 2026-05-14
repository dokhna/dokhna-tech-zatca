# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `0.x` (alpha) | Yes — best effort during pre-1.0 development |
| `>= 1.0.0` | Yes — latest minor receives security patches |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email `security@dokhna.tech` with:

1. A description of the issue and the affected versions.
2. A reproducer or proof of concept.
3. Your suggested severity rating.
4. Whether you would like public credit.

We will acknowledge receipt within 3 business days and aim to ship a fix within 30 days for critical issues. We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure).

## What we consider in scope

- Compromise of ZATCA-signed XML integrity (forged signatures, hash chain breaks).
- Leakage of certificates, private keys, or API secrets through the package surface.
- Injection vulnerabilities in XML, TLV QR construction, or HTTP request paths.
- Dependency vulnerabilities in shipped runtime dependencies.

## What we consider out of scope

- Vulnerabilities in `mongoose`, `pg`, or other peer dependencies (report upstream).
- Vulnerabilities in the OpenSSL CLI binary on the host system (report to your OS vendor).
- Issues in example code under `examples/`.
- Issues that require attacker-controlled access to the same Node.js process as the package.
