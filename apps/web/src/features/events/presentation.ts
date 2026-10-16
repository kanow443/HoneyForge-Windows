import type { Event } from "../../shared/api/models";
import { cleanText } from "../../shared/ui";
const labels: Record<string, string> = {
  "tcp.connect": "TCP-подключение",
  "tcp.request": "TCP-запрос",
  "tcp.disconnect": "TCP-соединение закрыто",
  "http.request": "HTTP-запрос",
  "http.login": "Попытка входа в портал",
  "ssh.connect": "Подключение по SSH",
  "ssh.login.failed": "Неудачный вход по SSH",
  "ssh.login.success": "Успешный вход по SSH",
  "ssh.command": "Команда SSH",
  "ssh.output": "Вывод SSH",
  "ssh.client.version": "Представление SSH-клиента",
  "ssh.client.kex": "Параметры SSH-клиента",
  "ssh.file.download": "Сообщение о загрузке файла",
  "ssh.file.download.failed": "Ошибка загрузки файла",
  "ssh.file.upload": "Сообщение о передаче файла",
  "ssh.disconnect": "SSH-соединение закрыто",
  "ssh.forward": "Перенаправление SSH",
  "network.blocked": "Исходящее соединение заблокировано",
  "sensor.error": "Ошибка агента",
};
export function eventLabel(type: string) {
  return labels[type] ?? type;
}
const notes: Record<string, string> = {
  "ssh.client.version":
    "Строка представления отправлена SSH-клиентом. Она не подтверждает ОС или личность источника.",
  "ssh.client.kex":
    "Параметры рукопожатия получены от SSH-клиента. По ним нельзя подтвердить ОС или личность источника.",
  "ssh.file.download":
    "Это сообщение сенсора о загрузке в эмулируемую среду. Оно не подтверждает наличие сохранённого содержимого файла.",
  "ssh.file.download.failed":
    "Сенсор сообщил о неудачной попытке загрузки. Это не свидетельство сохранённого файла.",
  "ssh.file.upload":
    "Это сообщение сенсора о передаче файла в эмулируемую среду. Доступность содержимого файла этим событием не подтверждается.",
};
export function eventNote(type: string) {
  return notes[type];
}
export function eventSummary(e: Event) {
  const fields =
    e.event_type === "ssh.client.version"
      ? [e.payload.version, e.payload.client_version, e.payload.message]
      : e.event_type === "ssh.client.kex"
        ? [e.payload.hassh, e.payload.fingerprint, e.payload.message]
        : e.event_type.startsWith("ssh.file.")
          ? [
              e.payload.url,
              e.payload.destination,
              e.payload.filename,
              e.payload.outfile,
              e.payload.error,
              e.payload.message,
            ]
          : [
              e.payload.command,
              e.payload.input,
              e.payload.path,
              e.payload.url,
              e.payload.filename,
              e.payload.outfile,
              e.payload.text,
              e.payload.message,
              e.payload.username,
            ];
  return cleanText(
    fields.find(
      (value) => value !== undefined && value !== null && value !== "",
    ) ?? "",
  );
}
