"""
OTLP Export Bridge for Arize Phoenix
------------------------------------
Receives JSON span batches from Node.js / JavaScript multi-agent execution
and sends standard OTLP protobuf spans to Phoenix at http://localhost:6006/v1/traces.
"""

import sys
import json
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource

PHOENIX_ENDPOINT = "http://localhost:6006/v1/traces"
PROJECT_NAME = "default"

def main():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            return
        spans_data = json.loads(raw_input)
        if not isinstance(spans_data, list):
            spans_data = [spans_data]

        resource = Resource.create({
            "service.name": "boston-hotel-intelligence",
            "project.name": PROJECT_NAME,
        })
        provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(endpoint=PHOENIX_ENDPOINT)
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        tracer = trace.get_tracer("boston-agent-tracer")

        # Map and emit each span
        for item in spans_data:
            name = item.get("name", "Agent Step")
            kind = item.get("kind", "AGENT")
            with tracer.start_as_current_span(name) as s:
                s.set_attribute("openinference.span.kind", kind)
                for k, v in item.get("attributes", {}).items():
                    if v is not None:
                        s.set_attribute(k, v)

        print(json.dumps({"success": True, "exported": len(spans_data)}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    main()
