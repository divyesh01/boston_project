import { z } from "npm:zod";

export function createApiHandler({ bodySchema, querySchema, paramsSchema, headersSchema }, handler) {
  return async (req, ...args) => {
    try {
      let body = {};
      let query = {};
      let headers = {};
      
      // Parse Query
      if (querySchema) {
        const url = new URL(req.url, "http://localhost");
        const queryObj = Object.fromEntries(url.searchParams.entries());
        const parseResult = querySchema.safeParse(queryObj);
        if (!parseResult.success) {
          const details = parseResult.error.errors.map(err => ({ field: err.path.join('.'), issue: err.message }));
          return Response.json({ error: "Bad Request", code: "VALIDATION_ERROR", details }, { status: 400 });
        }
        query = parseResult.data;
      }
      
      // Parse Headers
      if (headersSchema) {
        const headerObj = {};
        for (const [key, value] of req.headers.entries()) {
          headerObj[key.toLowerCase()] = value;
        }
        const parseResult = headersSchema.safeParse(headerObj);
        if (!parseResult.success) {
          const details = parseResult.error.errors.map(err => ({ field: err.path.join('.'), issue: err.message }));
          return Response.json({ error: "Bad Request", code: "VALIDATION_ERROR", details }, { status: 400 });
        }
        headers = parseResult.data;
      }

      // Parse Body
      if (bodySchema) {
        let rawBody;
        try {
          rawBody = await req.json();
        } catch (e) {
          return Response.json({ error: "Bad Request", code: "INVALID_JSON", details: "Malformed JSON payload" }, { status: 400 });
        }
        const parseResult = bodySchema.safeParse(rawBody);
        if (!parseResult.success) {
          const details = parseResult.error.errors.map(err => ({ field: err.path.join('.'), issue: err.message }));
          return Response.json({ error: "Bad Request", code: "VALIDATION_ERROR", details }, { status: 400 });
        }
        body = parseResult.data;
      }

      return await handler({ body, query, headers, req }, ...args);

    } catch (error) {
      console.error("[API_HANDLER_ERROR]", error);
      return Response.json({ error: "Internal Server Error", code: "SERVER_ERROR" }, { status: 500 });
    }
  };
}
