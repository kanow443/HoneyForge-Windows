"""Pure, deterministic rules. Findings always refer to observed events."""
from dataclasses import dataclass


@dataclass(frozen=True)
class RuleMatch:
    rule_id: str
    title: str
    severity: str
    explanation: str
    observation: str


def match_event(event_type: str, payload: dict) -> list[RuleMatch]:
    matches = []
    if event_type == "http.request" and payload.get("decoy_access"):
        matches.append(RuleMatch("decoy-access", "Обращение к приманке", "medium",
            "Клиент запросил ресурс, специально добавленный в профиль ловушки.", "observed"))
    if event_type == "ssh.command":
        command = str(payload.get("command", "")).strip()
        executable = command.split(" ", 1)[0]
        if executable in {"uname", "id", "whoami", "hostname", "cat", "ls", "pwd"}:
            matches.append(RuleMatch("environment-discovery", "Осмотр окружения", "low",
                "Эмулятор зафиксировал команду чтения сведений об окружении. Это признак разведки, не доказательство злого умысла.", "intent"))
        if executable in {"wget", "curl"}:
            matches.append(RuleMatch("download-intent", "Попытка загрузки", "high",
                "В эмуляторе введена команда загрузки. Выполнение сетевого соединения этим событием не подтверждается.", "intent"))
    if event_type == "network.blocked":
        matches.append(RuleMatch("blocked-egress", "Исходящее соединение запрещено", "high",
            "Счётчик DROP сетевой политики зафиксировал заблокированные исходящие пакеты. Количество пакетов не равно количеству соединений; адрес назначения этим агрегатом не определяется.", "observed"))
    return matches
