"""Check the concrete two-domain Caddy routing without any public DNS/ACME claim."""
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx

proof={'at':datetime.now(UTC).isoformat(),'scope':'Local HTTP routing and Caddy configuration; public ACME issuance not claimed','checks':{}}
with httpx.Client(base_url='http://127.0.0.1:19080',trust_env=False,follow_redirects=False) as client:
 for path in ['/assets/sync/v1/enroll','/agent/v1/runtimes','/docs','/openapi.json']:
  r=client.get(path,headers={'Host':'localhost'})
  assert r.status_code==404,(path,r.status_code)
 # In local internal-CA mode there is no real challenge: this reaches management:80's redirect.
 # Other management paths are handled by the local front door's generic404 above.
 r=client.get('/.well-known/acme-challenge/acceptance-nonexistent',headers={'Host':'localhost'})
 assert r.status_code in {301,308},r.status_code
 proof['checks']={'management_http_paths_not_exposed':True,'standard_http01_path_routed_to_management_http':True}
 Path('docs/evidence/backend/challenge-route.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps(proof['checks']))
