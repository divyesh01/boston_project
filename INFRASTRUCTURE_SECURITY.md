# Infrastructure Security Playbook

This document details the necessary infrastructure-level security configurations required before deploying **Red Roof Intelligence** to a production environment. Since these settings are enforced at the network or edge level, they cannot be handled solely within the application code.

## 1. TLS & Transport Security

### 1.1 Certificates
- Ensure the production domain has a valid TLS certificate issued by a trusted CA (e.g., Let's Encrypt).
- **Minimum Protocol:** Enforce TLS 1.2 or TLS 1.3 across all endpoints. Deprecated protocols (SSLv3, TLS 1.0, TLS 1.1) must be disabled at the edge/load balancer.

### 1.2 HTTP to HTTPS Redirects
- All traffic arriving on port 80 (HTTP) must be permanently redirected (HTTP 301 or 308) to port 443 (HTTPS).
- Check your hosting provider (Vercel, AWS CloudFront, Cloudflare) settings to enforce this automatically.

## 2. Edge Security (WAF & DDoS)

If you are using Cloudflare, AWS WAF, or a similar edge provider, enable the following protections:

### 2.1 Web Application Firewall (WAF)
- Enable the **OWASP Core Rule Set (CRS)** to automatically block common attacks like SQL injection and XSS targeting your backend APIs.
- Configure rate limiting at the edge to block aggressive credential stuffing or brute-force bots before they reach the application.

### 2.2 DDoS Mitigation
- Enable "Under Attack Mode" or similar Layer 7 DDoS mitigation if experiencing unusual spikes in traffic.
- Ensure your origin server's IP address is hidden and only accepts traffic from your edge provider's IP ranges.

## 3. Environment Variables & Secrets Management

- **No Secrets in Source:** Never commit `.env.production` or `.env.local` to the repository.
- Use a secure vault (e.g., AWS Secrets Manager, Vercel Environment Variables, GitHub Secrets) to inject environment variables at build time.
- If using Base44 Cloud, ensure API keys and admin credentials are rotated regularly and scoped with minimal permissions.

## 4. Edge Headers (HSTS, CSP)

- A `vercel.json` file is included in this repository to automatically apply security headers when deployed on Vercel.
- If you deploy to a different provider (like NGINX, AWS CloudFront, or Netlify), you must replicate the headers defined in `vercel.json` (such as `Strict-Transport-Security` and `Content-Security-Policy`).
