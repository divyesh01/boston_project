# Property Isolation Domain Pack

Every property-scoped read, write, aggregate, cache entry, export, and UI view must
prove its `property_id` boundary. Test Property A cannot read, modify, aggregate, or
infer Property B. Global/portfolio access must be explicit, authorized, and tested.
Fallback property IDs or unscoped queries are security findings.

