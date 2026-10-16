"""Observed IoCs with source evidence. No claim that an address identifies a person."""
import csv
import io
import ipaddress
import json
from collections import defaultdict
from datetime import UTC
from uuid import UUID, uuid4, uuid5

from sqlalchemy import func, select

from honeyforge.infrastructure.models import Event, EvidenceArtifact, now

SCO_NAMESPACE = UUID('00abedb4-aa42-466c-9c01-fed23315a9b7')


def stix_time(value):
    return value.astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def scoop_id(kind, identity):
    value = json.dumps(identity, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return kind + '--' + str(uuid5(SCO_NAMESPACE, value))


class IntelligenceService:
    def __init__(self, database, queries):
        self.database, self.queries = database, queries

    def export(self, actor, command):
        with self.database.unit_of_work() as u:
            u.lock_write()
            conditions = self.queries._conditions(command.filters)
            if command.session_id:
                conditions.append(Event.session_id == str(command.session_id))
            total = u.session.scalar(select(func.count()).select_from(Event).where(*conditions))
            events = list(u.session.scalars(select(Event).where(*conditions).order_by(Event.observed_at, Event.id).limit(5000)))
            groups = defaultdict(list)
            sizes = {}
            for event in events:
                try:
                    address = ipaddress.ip_address(event.source_ip)
                    groups[('ipv4-addr' if address.version == 4 else 'ipv6-addr', str(address))].append(event)
                except ValueError:
                    pass
                artifact_id = event.payload.get('artifact_id')
                artifact = u.repo.get(EvidenceArtifact, artifact_id) if isinstance(artifact_id, str) else None
                if artifact and artifact.state == 'available' and artifact.deployment_id == event.deployment_id and artifact.generation == event.generation:
                    groups[('file', artifact.sha256)].append(event)
                    sizes[artifact.sha256] = artifact.size_bytes
            values = []
            for (kind, value), rows in sorted(groups.items()):
                values.append({'type': kind, 'value': value, 'number_observed': len(rows),
                    'first_observed': stix_time(min(e.observed_at for e in rows)),
                    'last_observed': stix_time(max(e.observed_at for e in rows)),
                    'event_ids': [e.id for e in rows], 'deployment_ids': sorted({e.deployment_id for e in rows}),
                    'generations': sorted({e.generation for e in rows}), 'provenance': sorted({e.provenance for e in rows})})
            timestamp = stix_time(now())
            identity_id = 'identity--' + str(uuid4())
            objects = [{'type': 'identity', 'spec_version': '2.1', 'id': identity_id,
                'created': timestamp, 'modified': timestamp, 'name': 'HoneyForge observation export', 'identity_class': 'system'}]
            for value in values:
                kind = value['type']
                identity = {'hashes': {'SHA-256': value['value']}} if kind == 'file' else {'value': value['value']}
                sco = {'type': kind, 'spec_version': '2.1', 'id': scoop_id(kind, identity), **identity}
                if kind == 'file':
                    sco['size'] = sizes[value['value']]
                objects.append(sco)
                objects.append({'type': 'observed-data', 'spec_version': '2.1', 'id': 'observed-data--' + str(uuid4()),
                    'created': timestamp, 'modified': timestamp, 'created_by_ref': identity_id,
                    'first_observed': value['first_observed'], 'last_observed': value['last_observed'],
                    'number_observed': value['number_observed'], 'object_refs': [sco['id']],
                    'x_honeyforge_event_ids': value['event_ids'], 'x_honeyforge_deployment_ids': value['deployment_ids'],
                    'x_honeyforge_generations': value['generations'], 'x_honeyforge_provenance': value['provenance']})
            bundle = {'type': 'bundle', 'id': 'bundle--' + str(uuid4()), 'objects': objects}
            columns = ['type', 'value', 'number_observed', 'first_observed', 'last_observed', 'event_ids', 'deployment_ids', 'generations', 'provenance']
            output = io.StringIO(newline='')
            writer = csv.DictWriter(output, fieldnames=columns)
            writer.writeheader()
            for value in values:
                writer.writerow({k: ';'.join(v) if isinstance(v, list) else v for k, v in value.items()})
            u.audit(actor, 'ioc.exported', 'selection', {'format': command.format, 'events': len(events), 'observables': len(values)})
            return {'format': command.format, 'content': output.getvalue() if command.format == 'csv' else json.dumps(bundle, ensure_ascii=False, indent=2),
                'media_type': 'text/csv' if command.format == 'csv' else 'application/stix+json',
                'filename': 'honeyforge-observed-ioc.' + ('csv' if command.format == 'csv' else 'json'),
                'event_count': len(events), 'total': total, 'truncated': total > len(events),
                'interpretation': 'Observed addresses and independently verified file hashes, not malicious indicators or visitor identity.'}
