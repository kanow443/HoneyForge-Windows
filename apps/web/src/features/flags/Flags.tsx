import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { ErrorNotice, Loading, PageHeader, Panel } from "../../shared/ui";
import { usePermissions } from "../auth/permissions";

export function FlagsPage() {
  const { role, can } = usePermissions();
  const client = useQueryClient();
  const admin = can("admin");
  const [binding, setBinding] = useState("");
  const [title, setTitle] = useState("");
  const [points, setPoints] = useState(100);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const challenges = useQuery({
    queryKey: ["flag-challenges", admin],
    queryFn: admin ? api.adminFlagChallenges : api.flagChallenges,
  });
  const scores = useQuery({ queryKey: ["flag-scoreboard"], queryFn: api.flagScoreboard });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["flag-challenges"] });
    void client.invalidateQueries({ queryKey: ["flag-scoreboard"] });
  };
  const create = useMutation({
    mutationFn: () => api.createFlagChallenge({ binding_id: binding.trim(), title: title.trim(), points }),
    onSuccess: () => { setBinding(""); setTitle(""); refresh(); },
  });
  const submit = useMutation({
    mutationFn: (id: string) => api.submitFlag(id, answers[id]?.trim() ?? ""),
    onSuccess: (result) => {
      setMessage(`Флаг принят: +${result.points} очков`);
      setAnswers((current) => ({ ...current, [result.challenge_id]: "" }));
      refresh();
    },
  });
  const state = useMutation({
    mutationFn: (entry: { id: string; enabled: boolean }) => api.setFlagChallenge(entry.id, entry.enabled),
    onSuccess: refresh,
  });
  return <>
    <PageHeader title="CTF-флаги" description="Маркеры размещаются в активных HTTP или SSH приманках через honeytokens. Участник находит маркер и отправляет его для зачёта." />
    {admin && <Panel>
      <h2>Создать задание</h2>
      <p className="muted">Сначала выпустите файловый или URL honeytoken для профиля, примените профиль и дождитесь подтверждённого состояния Running. ID текущей привязки указан на странице профиля. Флаг в приманке: значение BACKUP_ACCESS_KEY в формате HF&#123;значение&#125;.</p>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <label>ID привязки honeytoken <input required value={binding} onChange={(e) => setBinding(e.target.value)} /></label>
        <label>Название <input required maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Очки <input required type="number" min={1} max={10000} value={points} onChange={(e) => setPoints(Number(e.target.value))} /></label>
        <button className="button primary" disabled={create.isPending}>Создать</button>
      </form>
      <ErrorNotice error={create.error} />
    </Panel>}
    <Panel>
      <h2>Задания</h2>
      <ErrorNotice error={challenges.error || submit.error || state.error} onRetry={() => challenges.refetch()} />
      {message && <p role="status">{message}</p>}
      {challenges.isPending ? <Loading /> : !challenges.data?.length ? <p className="muted">Заданий пока нет.</p> : challenges.data.map((challenge) =>
        <div key={challenge.id} className="panel-note">
          <h3>{challenge.title} · {challenge.points} очков</h3>
          <p>{challenge.active ? "Доступно" : "Неактивно"}{challenge.solved ? " · уже зачтено" : ""}</p>
          {admin && <p className="mono">Привязка: {challenge.binding_id}</p>}
          {role === "participant" && challenge.active && !challenge.solved && <form onSubmit={(e) => { e.preventDefault(); setMessage(""); submit.mutate(challenge.id); }}>
            <input aria-label={`Флаг: ${challenge.title}`} placeholder="HF{...}" maxLength={100} value={answers[challenge.id] ?? ""} onChange={(e) => setAnswers((current) => ({ ...current, [challenge.id]: e.target.value }))} />
            <button className="button" disabled={submit.isPending || !answers[challenge.id]?.trim()}>Отправить флаг</button>
          </form>}
          {admin && <button className="button small" disabled={state.isPending} onClick={() => state.mutate({ id: challenge.id, enabled: !challenge.enabled })}>{challenge.enabled ? "Отключить" : "Включить"}</button>}
        </div>)}
    </Panel>
    <Panel>
      <h2>Результаты</h2>
      <ErrorNotice error={scores.error} onRetry={() => scores.refetch()} />
      {scores.isPending ? <Loading /> : scores.data?.length ? <div className="table-wrap"><table><thead><tr><th>Участник</th><th>Очки</th><th>Флаги</th></tr></thead><tbody>{scores.data.map((row) => <tr key={row.username}><td>{row.username}</td><td>{row.points}</td><td>{row.solves}</td></tr>)}</tbody></table></div> : <p className="muted">Решений пока нет.</p>}
    </Panel>
  </>;
}
