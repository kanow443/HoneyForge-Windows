from honeyforge.domain.errors import DomainError
from honeyforge.infrastructure.models import Event, PrivateCapture


class PrivateCaptureService:
    def __init__(self, uow_factory, keys):
        self.uow_factory, self.keys = uow_factory, keys

    def reveal(self, actor, event_id):
        with self.uow_factory() as u:
            u.lock_write()
            capture = u.repo.find(PrivateCapture, event_id=event_id)
            event = u.repo.get(Event, event_id)
            if not event or not capture:
                raise DomainError("capture_unavailable", "No encrypted observation exists for this event", 404)
            try:
                content = self.keys.decrypt(capture.envelope)
            except Exception:
                raise DomainError("capture_key_unavailable", "The original evidence key is required for decryption", 503) from None
            # Audit contains only identifiers, never the revealed values.
            u.audit(actor, "private_capture.revealed", event_id, {"capture_id": capture.capture_id})
            return {"event_id": event_id, "capture_id": capture.capture_id, "content": content}
