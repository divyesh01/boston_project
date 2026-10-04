# Local native R2 raw-upload regression

Run from the repository with its normal dependencies and Wrangler installed locally or globally. The runner resolves the installed package and fails when it is missing; it does not install tooling automatically:

    node tests/fixtures/native-r2/run.mjs

This starts Wrangler locally on 127.0.0.1:8794, using only the synthetic bucket
and fixture entry in this directory. It refuses an occupied port. The runner
stops only its captured child process tree and writes persistence, logs and
proof results into a fresh system temporary directory.

The fixture calls the actual bulk-import handler with synthetic scope and a
mock database; it does not prove the normal authentication flow or access to
production/cloud storage. Never use its entry/config as a deployment target.

Coverage includes native checksum/conditional writes, canonical scope guards,
50 MiB header and consumed limits, empty payloads, malformed lengths, native
missing-length 411, constructed length mismatches, transport aborts, and native
HEAD checks showing invalid objects absent. An incomplete HTTP message declaring
50 bytes while sending 20 requires client disconnection; the test checks that
transport failure and absence of the object rather than expecting an HTTP 400
while the server is still waiting for the remaining bytes.

The copied old-transform endpoint demonstrates the native known-length storage
requirement structurally; it does not invoke the old application handler.
Preferred S3 behavior is a separate contract. Node without the workerd
FixedLengthStream global is not a native R2 runtime; this test uses workerd.
