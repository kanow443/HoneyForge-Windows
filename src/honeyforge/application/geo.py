"""Offline MMDB lookups. Missing/private addresses remain explicitly unavailable."""
import ipaddress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import RLock

from sqlalchemy import func, select

from honeyforge.infrastructure.models import Event, now


class GeoDatabase:
    def __init__(self, filename, expected):
        self.filename, self.expected, self.reader, self.signature = filename, expected, None, None
        self.lock = RLock()

    def _open(self):
        import maxminddb
        if not self.filename:
            return {'status': 'unavailable', 'reason': 'not_configured', 'built_at': None, 'database_type': None}
        try:
            path = Path(self.filename)
            stat = path.stat()
            signature = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
            if signature != self.signature:
                candidate = maxminddb.open_database(path)
                metadata = candidate.metadata()
                if self.expected.lower() not in metadata.database_type.lower():
                    candidate.close()
                    return {'status': 'unavailable', 'reason': 'wrong_database_type', 'built_at': None, 'database_type': metadata.database_type}
                if self.reader:
                    self.reader.close()
                self.reader, self.signature = candidate, signature
            metadata = self.reader.metadata()
            age_days = max(0, (datetime.now(UTC) - datetime.fromtimestamp(metadata.build_epoch, UTC)).days)
            return {'status': 'available', 'reason': None, 'age_days': age_days, 'stale': age_days > 62,
                'provider': 'DB-IP' if 'dbip' in metadata.database_type.lower() or 'db-ip' in metadata.database_type.lower() else 'MMDB',
                'attribution_url': 'https://db-ip.com' if 'dbip' in metadata.database_type.lower() or 'db-ip' in metadata.database_type.lower() else None,
                'built_at': datetime.fromtimestamp(metadata.build_epoch, UTC).isoformat(),
                'database_type': metadata.database_type, 'size_bytes': stat.st_size}
        except Exception:
            # Do not leak private configured paths through HTTP diagnostics.
            if self.reader:
                self.reader.close()
            self.reader, self.signature = None, None
            return {'status': 'unavailable', 'reason': 'unreadable_database', 'built_at': None, 'database_type': None}

    def status(self):
        with self.lock:
            return self._open()

    def lookup(self, address):
        with self.lock:
            if self._open()['status'] != 'available':
                return None
            try:
                return self.reader.get(address)
            except Exception:
                return None


class GeoService:
    def __init__(self, database, config):
        self.database = database
        self.city = GeoDatabase(config.geo_city_db, 'City')
        self.asn = GeoDatabase(config.geo_asn_db, 'ASN')

    def lookup(self, value):
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            return {'source_ip': value, 'status': 'unavailable', 'reason': 'invalid_address'}
        if not address.is_global:
            return {'source_ip': value, 'status': 'unavailable', 'reason': 'private_or_reserved_address'}
        city, asn = self.city.lookup(str(address)), self.asn.lookup(str(address))
        result = {'source_ip': value, 'status': 'available' if city or asn else 'unavailable',
            'reason': None if city or asn else 'database_missing_or_address_not_found',
            'country': None, 'city': None, 'latitude': None, 'longitude': None,
            'asn': None, 'organization': None, 'accuracy_radius_km': None}
        if city:
            location = city.get('location', {})
            result.update(country=city.get('country', {}).get('names', {}).get('ru') or city.get('country', {}).get('names', {}).get('en'),
                city=city.get('city', {}).get('names', {}).get('ru') or city.get('city', {}).get('names', {}).get('en'),
                latitude=location.get('latitude'), longitude=location.get('longitude'),
                accuracy_radius_km=location.get('accuracy_radius'))
        if asn:
            result.update(asn=asn.get('autonomous_system_number'), organization=asn.get('autonomous_system_organization'))
        return result

    def top(self):
        cutoff = now() - timedelta(hours=24)
        with self.database.sessions() as s:
            rows = s.execute(select(Event.source_ip, func.count().label('count')).where(
                Event.observed_at >= cutoff).group_by(Event.source_ip).order_by(func.count().desc(), Event.source_ip).limit(20)).all()
        return {'city_database': self.city.status(), 'asn_database': self.asn.status(),
            'since': cutoff, 'time_basis': 'observed_at', 'sources': [{**self.lookup(ip), 'event_count': count} for ip, count in rows],
            'interpretation': 'Approximate local database enrichment. IP and location do not identify a person.'}
