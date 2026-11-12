# Common mistakes (sample)

A fictional site with deliberate mistakes, for Preflight's demo and tests. Nothing here
is meant to run. The "API key" in agent-manifest.json is fake.

| Mistake | Check that catches it |
| --- | --- |
| `front_man` names `rental_desk`, but the runtime starts from `intake_router` | Front agent matches the manifest |
| A key in `llm_router.api_key` | No credentials in agent-manifest.json |
| No `peer_policy` or `allowed_peers` | Manifest states its peer policy |
| `${OTARI_API_KEY}` left in the network | Network is data only |
| `repair_desk` is referenced but not defined | Reference runtime's validator |
| `rental_desk` is called but has no input schema | Callable agents have JSON Schema inputs |
| A peer URL over HTTP with no network name | Peer references are HTTPS URLs ending in a network name |
| `sly_data: "*"` toward a peer | Private context crosses only by named fields |
| "make up a realistic response" | Instructions do not ask the model to invent results |
| A links.json binding that is not a URL | links.json maps names to peer-network URLs |
| Page-local `website_*` tools | Works without the publisher's page |
