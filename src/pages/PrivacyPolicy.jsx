import React from 'react';
import { Link } from 'react-router-dom';
import { Shield, ArrowLeft, FileText } from 'lucide-react';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-800 py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-gray-200 p-8 sm:p-12">
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 hover:text-red-800 mb-6 transition"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Application
        </Link>

        <div className="flex items-center gap-3 mb-6 pb-4 border-b border-gray-100">
          <div className="rounded-full bg-red-100 p-2.5 text-red-700">
            <Shield className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Privacy Policy</h1>
            <p className="text-xs text-gray-500">Effective Date: August 14, 2026</p>
          </div>
        </div>

        <div className="space-y-6 text-sm leading-relaxed text-gray-600">
          <section>
            <h2 className="text-base font-bold text-gray-900 mb-2">1. Overview</h2>
            <p>
              Red Roof Intelligence ("the Platform", "we", "us") is a dedicated hotel management, revenue optimization, and operational auditing system. This Privacy Policy outlines how operational hotel records, financial summaries, user credentials, and shift audit logs are collected, processed, and safeguarded.
            </p>
          </section>

          <section>
            <h2 className="text-base font-bold text-gray-900 mb-2">2. Information We Collect</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>User Account Information:</strong> Name, professional email address, role assignments, and encrypted authentication credentials (passwords hashed via PBKDF2/scrypt, TOTP MFA secrets).</li>
              <li><strong>Property Operational Data:</strong> Property Management System (PMS) report uploads, daily room revenue, occupancy percentages, Average Daily Rate (ADR), RevPAR, and room type allocations.</li>
              <li><strong>Transaction &amp; Audit Records:</strong> Front-desk shift logs, cashier adjustments, rate override counts, and payment channel distributions (cash, card settlement summaries, direct bills).</li>
              <li><strong>Technical Metadata:</strong> Access timestamps, IP addresses for rate-limiting and audit trails, browser types, and cryptographically chained system logs.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-bold text-gray-900 mb-2">3. How We Use Collected Information</h2>
            <p>We process operational data exclusively for:</p>
            <ul className="list-disc pl-5 space-y-1.5 mt-2">
              <li>Generating portfolio-wide financial analytics, calendar rollups, and yield optimization recommendations.</li>
              <li>Detecting shift cash variances, rate override anomalies, and cashier shrinkage.</li>
              <li>Reconciling expected PMS collections against merchant card settlement batches.</li>
              <li>Maintaining immutable, server-authoritative audit logs of administrative actions.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-bold text-gray-900 mb-2">4. Data Protection &amp; Security Standards</h2>
            <p>
              We enforce strict technical and organizational safeguards in accordance with industry security best practices and applicable data protection standards:
            </p>
            <ul className="list-disc pl-5 space-y-1.5 mt-2">
              <li><strong>Transport Encryption:</strong> All communications are transmitted over TLS 1.3 / HTTPS with mandatory HTTP Strict Transport Security (HSTS).</li>
              <li><strong>Access Controls:</strong> Granular Role-Based Access Control (RBAC) and property-level data isolation prevent unauthorized access across accounts.</li>
              <li><strong>Zero-Trust Session Validation:</strong> Sessions are managed via secure, HttpOnly authentication tokens with strict server-side validation.</li>
              <li><strong>Audit Integrity:</strong> Log entries are cryptographically chained on the server using HMAC-SHA256 to ensure tamper-evident forensic records.</li>
              <li><strong>Input &amp; Output Hardening:</strong> User-supplied data is sanitized on ingest and on render, and uploads are validated by type and size to prevent injection or payload execution.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-bold text-gray-900 mb-2">5. Data Sharing &amp; Third Parties</h2>
            <p>
              We do not sell, rent, or monetize hotel operational data. Data is shared only with verified infrastructure providers (cloud database hosting, authentication gateways, and channel/OTA connectors you explicitly authorize) strictly necessary to operate the platform. We do not use operational data for advertising or cross-context behavioral profiling.
            </p>
          </section>

          <section>
            <h2 className="text-base font-bold text-gray-900 mb-2">6. Data Retention &amp; Deletion</h2>
            <p>
              Operational and financial records are retained for the duration of your active subscription and for any period required to satisfy legitimate business, tax, or legal obligations. Audit logs are retained as tamper-evident records for forensic and compliance purposes. When an account is terminated, personal account data is deleted or anonymized pursuant to our retention schedule, subject to legal hold exceptions.
            </p>
          </section>

          <section>
            <h2 className="text-base font-bold text-gray-900 mb-2">7. Your Privacy Rights</h2>
            <p>
              Depending on your jurisdiction, you may have the right to access, correct, export (data portability), or delete your personal information, and to object to or restrict certain processing. To exercise these rights, submit a request through your designated System Administrator or Property Owner. We will verify the request and respond within the timeframe required by applicable law (for example, under the CCPA/CPRA or GDPR frameworks where they apply). We will not discriminate against users who exercise their privacy rights.
            </p>
          </section>

          <section>
            <h2 className="text-base font-bold text-gray-900 mb-2">8. Children's Privacy</h2>
            <p>
              The Platform is a business-to-business tool intended for authorized hotel personnel and is not directed to individuals under the age of 18. We do not knowingly collect personal information from minors.
            </p>
          </section>

          <section>
            <h2 className="text-base font-bold text-gray-900 mb-2">9. International Data Transfers</h2>
            <p>
              If operational data is processed or stored in a jurisdiction different from where it originates, we rely on appropriate safeguards (such as contractual clauses and infrastructure-provider compliance certifications) to protect transferred data in accordance with this Policy.
            </p>
          </section>

          <section>
            <h2 className="text-base font-bold text-gray-900 mb-2">10. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time to reflect changes in our practices or legal requirements. Material changes will be communicated through the Platform, and the "Effective Date" above will be revised accordingly.
            </p>
          </section>

          <section>
            <h2 className="text-base font-bold text-gray-900 mb-2">11. Contact &amp; Administration</h2>
            <p>
              For data access requests, audit inquiries, or privacy concerns, contact your designated System Administrator or Property Owner directly within the platform. For escalations, use the in-platform support channels provided to your organization.
            </p>
          </section>
        </div>

        <div className="mt-8 pt-4 border-t border-gray-100 text-xs text-gray-500 flex flex-wrap items-center gap-2">
          <FileText className="h-3.5 w-3.5" />
          <span>Related:</span>
          <Link to="/terms" className="font-medium text-red-700 hover:text-red-800 hover:underline">
            Terms of Service
          </Link>
        </div>
      </div>
    </div>
  );
}
