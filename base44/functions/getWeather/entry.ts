import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';

// Security (#29): the OpenWeather API key lives ONLY server-side in a Base44
// secret (OPENWEATHER_API_KEY). The browser calls this function with lat/lon and
// never sees the key. Falls back gracefully (HTTP 503) when no key is configured.
export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const apiKey = secrets.get('OPENWEATHER_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'OpenWeather API key is not configured on the server.' }, { status: 503 });
    }

    let body: any = {};
    try {
      const raw = await req.json();
      if (raw && typeof raw === 'object') body = raw;
    } catch { /* empty body ok */ }

    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json({ error: 'lat and lon (numbers) are required.' }, { status: 400 });
    }

    const url = new URL("https://api.openweathermap.org/data/3.0/onecall");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("exclude", "minutely");
    url.searchParams.set("units", "metric");
    url.searchParams.set("appid", apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
      return Response.json({ error: `OpenWeather request failed: HTTP ${res.status}` }, { status: res.status });
    }
    const data = await res.json();
    return Response.json(data);
  } catch (error) {
    console.error("GetWeather error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
