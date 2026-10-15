import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { meQuery } from "@/lib/api";
import { ACTIVITY_ICONS } from "@/lib/activity-icons";
import {
  ActivityRequestError, clearPendingActivity, getActivities, performActivity, readPendingActivity, savePendingActivity,
  isActivityInFlight, subscribeActivityChanges,
  type ActivityAction, type ActivityCell, type ActivityRequest, type ActivityResponse,
} from "@/lib/activities";
import { retryNativeActivityRequest } from "@/lib/native-activity-host";
import "@/lib/native-mines-host";
import "@/lib/native-ddplay-host";
import "@/lib/native-gypsy-host";
import "./ActivityCenter.css";

const activityKey = (characterId: number) => ["account", "activities", characterId] as const;
const number = (value: number) => value.toLocaleString("zh-CN");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请稍后重试。";

function CellImage({ cell }: { cell: ActivityCell }) {
  const [failed, setFailed] = useState(false);
  const path = cell.image?.startsWith("/") && !cell.image.startsWith("//") ? cell.image : undefined;
  useEffect(() => setFailed(false), [path]);
  return path && !failed ? <img src={path} alt="" loading="lazy" onError={() => setFailed(true)} /> : null;
}

export function ActivityCenter({ onClose, initialCharacterId }: { onClose: () => void; initialCharacterId?: number }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const detailsRef = useRef<HTMLElement>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const nativeRequestRef = useRef<AbortController | null>(null);
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const [chosenCharacter, setChosenCharacter] = useState<number | null>(initialCharacterId ?? null);
  const characters = me.data?.characters ?? [];
  const characterId = characters.find((character) => character.id === chosenCharacter)?.id ?? characters[0]?.id ?? 0;
  const matchesGameCharacter = initialCharacterId ? characterId === initialCharacterId : characters.length === 1;
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [openingNative, setOpeningNative] = useState("");
  const [sharedBusy, setSharedBusy] = useState(false);
  const [retry, setRetry] = useState<ActivityRequest | null>(null);
  const [storageError, setStorageError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [mailedCount, setMailedCount] = useState(0);
  const activities = useQuery({
    queryKey: activityKey(characterId), queryFn: () => getActivities(characterId), enabled: characterId > 0,
    refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false, staleTime: 0,
  });
  const snapshot = activities.data?.characterId === characterId ? activities.data : undefined;
  const selected = snapshot?.activities.find((activity) => activity.id === selectedId) ?? snapshot?.activities[0];
  const locked = busy || sharedBusy || Boolean(openingNative) || Boolean(retry) || Boolean(storageError) || activities.isFetching;
  const currentCharacterRef = useRef(characterId);
  currentCharacterRef.current = characterId;

  useEffect(() => {
    mountedRef.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      mountedRef.current = false;
      nativeRequestRef.current?.abort();
      dialog?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    nativeRequestRef.current?.abort();
    nativeRequestRef.current = null;
    setOpeningNative("");
    setNotice(""); setActionError(""); setMailedCount(0); setStorageError(""); setRetry(null);
    const sync = () => {
      setSharedBusy(isActivityInFlight(characterId));
      try { setRetry(characterId ? readPendingActivity(characterId) : null); setStorageError(""); }
      catch (error) { setStorageError(errorMessage(error)); }
    };
    sync();
    return subscribeActivityChanges((id) => { if (id === characterId) sync(); });
  }, [characterId]);

  const submit = async (pending: ActivityRequest) => {
    if (busyRef.current || isActivityInFlight(pending.characterId)) return;
    busyRef.current = true;
    setBusy(true); setActionError(""); setNotice(""); setMailedCount(0);
    try {
      savePendingActivity(pending);
      setRetry(pending);
      await queryClient.cancelQueries({ queryKey: activityKey(pending.characterId) });
      const next = await (retryNativeActivityRequest(pending) ?? performActivity(pending));
      queryClient.setQueryData<ActivityResponse>(activityKey(pending.characterId), (old) => !old || next.revision >= old.revision ? next : old);
      clearPendingActivity(pending);
      if (mountedRef.current && currentCharacterRef.current === pending.characterId) {
        setRetry(null);
        setNotice(next.message || "操作已完成。");
        setMailedCount(next.mailedCount ?? next.mailIds?.length ?? 0);
      }
    } catch (error) {
      if (error instanceof ActivityRequestError && !error.uncertain) {
        try { clearPendingActivity(pending); if (mountedRef.current && currentCharacterRef.current === pending.characterId) setRetry(null); }
        catch { /* Preserve the same request when its stored receipt cannot be cleared. */ }
      }
      if (mountedRef.current && currentCharacterRef.current === pending.characterId) setActionError(errorMessage(error));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const act = (activityId: string, action: ActivityAction) => {
    if (locked || !characterId || busyRef.current) return;
    let pending: ActivityRequest;
    try { pending = { characterId, activityId, action: { ...action }, requestId: crypto.randomUUID() }; }
    catch { setActionError("浏览器无法创建操作编号，尚未提交。请在本机游戏地址打开。"); return; }
    void submit(pending);
  };

  const selectActivity = (id: string) => {
    if (openingNative) return;
    setSelectedId(id);
    detailsRef.current?.scrollTo({ top: 0 });
    if (window.matchMedia("(max-width: 760px)").matches) {
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
      requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ behavior, block: "start" }));
    }
  };

  const openNative = async (kind: "wardrobe" | "pair" | "mines" | "ddplay" | "gypsy" | "moonlight" | "treasure" | "purr" | "carnival" | "first-recharge" | "charge" | "forthright") => {
    if (locked || !matchesGameCharacter || nativeRequestRef.current) return;
    const request = new AbortController();
    nativeRequestRef.current = request;
    const label = kind === "pair" ? "原版32格翻牌" : kind === "mines" ? "原版70格扫雷" : kind === "ddplay" ? "原版弹弹乐" : kind === "gypsy" ? "原版吉普赛商人" : kind === "moonlight" ? "原版月光宝盒" : kind === "treasure" ? "原版迷宫寻宝" : kind === "purr" ? "原版啵咕大转盘" : kind === "carnival" ? "原版节日狂欢" : kind === "first-recharge" ? "原版首充大礼" : kind === "charge" ? "原版充值大赠送" : kind === "forthright" ? "原版至尊豪礼" : "魔法衣橱";
    setOpeningNative(label); setActionError("");
    try {
      const open = kind === "pair" ? window.workshopShowPair : kind === "mines" ? window.workshopShowMines : kind === "ddplay" ? window.workshopShowDDPlay : kind === "gypsy" ? window.workshopShowGypsy : kind === "moonlight" ? window.workshopShowMoonlight : kind === "treasure" ? window.workshopShowTreasure : kind === "purr" ? window.workshopShowPurr : kind === "carnival" ? window.workshopShowCarnival : kind === "first-recharge" ? window.workshopShowFirstRecharge : kind === "charge" ? window.workshopShowCharge : kind === "forthright" ? window.workshopShowForthright : window.workshopShowWardrobe;
      const opened = await open?.(characterId, request.signal);
      if (!mountedRef.current || request.signal.aborted) return;
      if (opened) onClose();
      else setActionError(`${label}窗口未能打开。请进入游戏大厅后重试；也可继续使用网页活动。`);
    } catch (error) {
      if (mountedRef.current && !request.signal.aborted) setActionError(errorMessage(error));
    } finally {
      if (nativeRequestRef.current === request) {
        nativeRequestRef.current = null;
        if (mountedRef.current) setOpeningNative("");
      }
    }
  };

  return (
    <dialog ref={dialogRef} className="activity-center" aria-labelledby="activity-center-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <header className="activity-center__header">
        <div><span className="activity-center__eyebrow">怀旧时光 · 每日新趣</span><h2 id="activity-center-title">活动中心</h2></div>
        <div className="activity-center__account">
          <label>当前角色<select value={characterId || ""} disabled={!characters.length || busy || sharedBusy || Boolean(openingNative)}
            onChange={(event) => setChosenCharacter(Number(event.target.value))}>
            {!characters.length && <option value="">暂无角色</option>}
            {characters.map((character) => <option value={character.id} key={character.id}>{character.nickname} · {character.level}级</option>)}
          </select></label>
          <div className="activity-center__wallet"><span>活动积分</span><strong>{snapshot ? number(snapshot.points) : "—"}</strong></div>
        </div>
        <button type="button" className="activity-center__close" onClick={onClose} aria-label="关闭活动中心，返回游戏" autoFocus>×</button>
      </header>

      <div className="activity-center__body">
        <div className="activity-center__toolbar">
          <p>完成任务攒积分，奖励通过游戏邮件送达。</p>
          <button type="button" className="activity-center__quiet" disabled={!characterId || busy || activities.isFetching}
            onClick={() => { void activities.refetch(); }}>{activities.isFetching ? "读取中…" : "刷新进度"}</button>
        </div>

        {me.isPending && <p className="activity-center__empty" role="status">正在读取角色…</p>}
        {!me.isPending && !me.data && <p className="activity-center__empty">请先登录游戏账号，再打开活动中心。</p>}
        {me.data && !characters.length && <p className="activity-center__empty">这个账号还没有角色。请先进入游戏创建角色。</p>}
        {characterId > 0 && activities.isPending && <p className="activity-center__empty" role="status">正在准备活动…</p>}
        {activities.error && <p className="activity-center__notice activity-center__notice--error" role="alert">{errorMessage(activities.error)} 可点击“刷新进度”重新读取。</p>}
        {storageError && <p className="activity-center__notice activity-center__notice--error" role="alert">{storageError}</p>}
        {(retry || actionError) && <div className="activity-center__notice activity-center__notice--error" role="alert">
          <p>{actionError || (busy || sharedBusy ? "正在提交，请稍候…" : "上一次操作的结果尚未确认。重试会核对同一笔操作，不会创建第二笔。")}</p>
          {retry && !busy && <button type="button" className="activity-center__button" disabled={sharedBusy || activities.isFetching}
            onClick={() => { void submit(retry); }}>重试上一次操作</button>}
        </div>}
        <div role="status" aria-live="polite" aria-atomic="true">
          {openingNative && <p className="activity-center__notice">正在打开游戏内的{openingNative}…</p>}
          {notice && <p className="activity-center__notice">{notice}
            {mailedCount > 0 && <span className="activity-center__mail">已发出 {mailedCount} 封奖励邮件，请到游戏邮箱领取附件。</span>}
          </p>}
        </div>

        {snapshot && <>
          <section className="activity-center__tasks" aria-labelledby="activity-tasks-title">
            <div className="activity-center__section-title"><h3 id="activity-tasks-title">今日小目标</h3><span>{snapshot.day}</span></div>
            <div className="activity-center__task-list">
              {snapshot.tasks.map((task) => <article key={task.id} className="activity-center__task">
                <div><strong>{task.title}</strong><span>+{number(task.points)} 积分</span></div>
                <progress max={Math.max(1, task.target)} value={Math.min(task.current, task.target)} aria-label={`${task.title}进度`} />
                <footer><span>{number(task.current)} / {number(task.target)}</span>
                  <button type="button" className="activity-center__button" disabled={locked || task.claimed || task.current < task.target}
                    onClick={() => act("tasks", { type: "claim", choice: task.id })}>{task.claimed ? "已领取" : "领取积分"}</button>
                </footer>
              </article>)}
              {!snapshot.tasks.length && <p className="activity-center__muted">今日暂无任务。</p>}
            </div>
          </section>

          <div className="activity-center__main">
            <nav className="activity-center__catalog" aria-label="选择活动">
              <div className="activity-center__section-title"><h3>活动一览</h3><span>{snapshot.activities.length} 项</span></div>
              <div className="activity-center__tiles">
                {snapshot.activities.map((activity, index) => <button type="button" key={activity.id}
                  className={`activity-center__tile${selected?.id === activity.id ? " is-selected" : ""}`}
                  aria-pressed={selected?.id === activity.id} aria-controls="activity-detail" disabled={Boolean(openingNative)} onClick={() => selectActivity(activity.id)}>
                  {ACTIVITY_ICONS[activity.id] ? <span className="activity-center__original-icon" aria-hidden="true"><img src={ACTIVITY_ICONS[activity.id]} alt="" /></span>
                    : <span className={`activity-center__medallion activity-center__medallion--${index % 5}`} aria-hidden="true">{activity.title.slice(0, 1)}</span>}
                  <strong>{activity.title}</strong>
                </button>)}
              </div>
              <details className="activity-center__services"><summary>礼包服务</summary><p>已有礼包码在原游戏窗口使用。</p>
                <button type="button" className="activity-center__button" disabled={locked} onClick={() => {
                  if (window.workshopShowActivation?.()) onClose();
                  else setActionError("礼包窗口尚未就绪，请进入大厅后再试。");
                }}>打开激活礼包</button>
              </details>
            </nav>

            <section ref={detailsRef} id="activity-detail" className="activity-center__detail" aria-label={selected?.title ?? "活动详情"} aria-busy={busy}>
              {selected ? <>
                <div className="activity-center__detail-heading"><span className="activity-center__eyebrow">正在参与</span><h3>{selected.title}</h3><p>{selected.subtitle}</p></div>
                <dl className="activity-center__stats">{selected.stats.map((stat, index) => <div key={`${stat.label}-${index}`}><dt>{stat.label}</dt><dd>{typeof stat.value === "number" ? number(stat.value) : stat.value}</dd></div>)}</dl>
                {Boolean(selected.cells?.length) && <div className="activity-center__cells" style={{ "--activity-columns": Math.max(1, Math.min(12, selected.columns ?? 4)) } as CSSProperties}>
                  {selected.cells?.map((cell, index) => cell.action ? <button type="button" key={index}
                    className={`activity-center__cell activity-center__cell--${cell.tone ?? "default"}`} disabled={locked}
                    aria-label={`${cell.label}${cell.detail ? `，${cell.detail}` : ""}`} onClick={() => act(selected.id, cell.action!)}>
                    <CellImage cell={cell} /><strong>{cell.label}</strong>{cell.detail && <span>{cell.detail}</span>}
                  </button> : <div key={index} className={`activity-center__cell activity-center__cell--${cell.tone ?? "default"}`}>
                    <CellImage cell={cell} /><strong>{cell.label}</strong>{cell.detail && <span>{cell.detail}</span>}
                  </div>)}
                </div>}
                <div className="activity-center__actions">{selected.actions.map((button, index) => <div key={`${button.label}-${index}`}>
                  <button type="button" className="activity-center__button" disabled={locked || button.disabled}
                    aria-describedby={button.help ? `activity-help-${index}` : undefined} onClick={() => act(selected.id, button.action)}>{button.label}</button>
                  {button.help && <p id={`activity-help-${index}`}>{button.help}</p>}
                </div>)}</div>
                {selected.id === "sign" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter} onClick={() => {
                  if (window.workshopShowSign?.()) onClose();
                  else setActionError("签到窗口尚未就绪，请进入游戏大厅后再试。");
                }}>打开游戏签到窗口</button>{!matchesGameCharacter && <p className="activity-center__muted">请从这个角色的游戏大厅点击“活动”，再打开签到窗口。</p>}</>}
                {selected.id === "wardrobe" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("wardrobe"); }}>试用原版衣橱窗口</button>
                  <p className="activity-center__muted">原窗口仍在测试，连续翻页可能中断游戏。下方套装目录可正常查看。</p>
                  {!matchesGameCharacter && <p className="activity-center__muted">请从这个角色的游戏大厅点击“活动”，再打开衣橱窗口。</p>}</>}
                {selected.id === "pair" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("pair"); }}>试用原版32格翻牌</button>
                  <p className="activity-center__muted">原窗口仍在测试，牌局与网页配对独立。打开只读取进度；开始、翻牌及积分操作均由你确认。遇到未确认结果，请用上方按钮重试原操作；若原窗口无法恢复，核对后重新进入游戏。</p>
                  {!matchesGameCharacter && <p className="activity-center__muted">请从这个角色的游戏大厅点击“活动”，再打开原版翻牌。</p>}</>}
                {selected.id === "mines" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("mines"); }}>试用原版70格扫雷</button>
                  <p className="activity-center__muted">原场景仍在测试，70格存档与网页36格独立。打开只读取进度；开始和积分操作需要确认，三档奖励手动领取后通过游戏邮件送达。具体费用和奖品采用本地规则。</p>
                  {!matchesGameCharacter && <p className="activity-center__muted">请从这个角色的游戏大厅点击“活动”，再打开原版扫雷。</p>}</>}
                {selected.id === "ddplay" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("ddplay"); }}>试用原版弹弹乐</button>
                  <p className="activity-center__muted">原转轴和兑换窗口仍在测试，与网页弹弹乐共用进度及活动积分。打开只读取；每次转动消耗10积分，结果由本地服务决定。每10积分可兑换1份普通材料，通过游戏邮件送达；不接真实付款。</p>
                  {!matchesGameCharacter && <p className="activity-center__muted">请从这个角色的游戏大厅点击“活动”，再打开原版弹弹乐。</p>}</>}
                {selected.id === "first-gift" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("first-recharge"); }}>试用原版首充大礼</button>
                  <p className="activity-center__hint">本地任务解锁三档奖励；商城使用活动积分。任务凭证可验证、激活或赠送一次，首档与新手任务礼共用领取记录。无真实付款；原充值卡和赠卡美术仍待移植。</p></>}
                {selected.id === "luxury" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("forthright"); }}>试用原版至尊豪礼</button>
                  <p className="activity-center__muted">原四页仍在测试：累计任务礼共用领取记录，任务钥匙可抽三轮，三人拼团由真实角色加入，分期商店按窗口标注的UTC时段开放。未满团可退出，团长可取消；到期款项需手动结清退款。采用本地活动积分和普通材料，不接真实付款，不代表原服全服库存。</p>
                  {!matchesGameCharacter && <p className="activity-center__muted">请从这个角色的游戏大厅点击“活动”，再打开原版至尊豪礼。</p>}</>}
                {selected.id === "points-gift" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("charge"); }}>试用原版充值大赠送</button>
                  <p className="activity-center__hint">本地四页活动：今日任务、累计任务、启用后累计消费、积分兑换。累计任务档与活动积分礼共用领取记录，奖励由游戏邮件送达；兑换仅扣活动积分，消费不补算历史，不接真实付款。原窗口仍待游戏内验收。</p></>}
                {selected.id === "carnival" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("carnival"); }}>试用原版节日狂欢</button>
                  <p className="activity-center__muted">原12格转盘、动画和红包兑换窗口仍在测试，与旧网页骰盘分别存档，共用活动积分。打开只读取；本地12格等概率，每次10积分，连续模式一次确认最多5次，全部结果一次提交。停止或关闭不会撤销已提交奖励；普通材料直接寄邮件，动画不再次发奖。红包可兑换7种本地配方，不接真实付款。大奖直播原资源、全服奖池和排行尚未接入。</p>
                  {!matchesGameCharacter && <p className="activity-center__muted">请从这个角色的游戏大厅点击“活动”，再打开原版节日狂欢。</p>}</>}
                {selected.id === "wheel" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("purr"); }}>试用原版啵咕大转盘</button>
                  <p className="activity-center__muted">原双轮和领取、兑换窗口仍在测试。七级原窗与旧网页五星转盘分别存档，共用活动积分。打开只读取；开局20积分、普通追加10积分、保护追加20积分，本地追加成功率60%。0或1级可领20芯片，2至7级明确选择芯片或材料；每20芯片兑换1份普通材料，奖励寄邮件。原商城、付款和排行尚未接入。</p>
                  {!matchesGameCharacter && <p className="activity-center__muted">请从这个角色的游戏大厅点击“活动”，再打开原版啵咕大转盘。</p>}</>}
                {selected.id === "treasure" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("treasure"); }}>试用原版迷宫寻宝</button>
                  <p className="activity-center__muted">原窗口仍在测试，打开只读取。普通每次30积分、高级每次60积分，奖池为本地四种普通材料；连续选项为一次确认的5次有限批次。两边共用30格临时包，原窗单格取出会寄邮件并保留其余格；原券购买和全服排行尚未接入。</p>
                  {!matchesGameCharacter && <p className="activity-center__muted">请从这个角色的游戏大厅点击“活动”，再打开原版迷宫寻宝。</p>}</>}
                {selected.id === "moon" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("moonlight"); }}>试用原版月光宝盒</button>
                  <p className="activity-center__muted">原窗口仍在测试，打开只读取。三档本地开盒为1、3、5次，每次20活动积分；与网页共用临时背包，原窗可勾选材料及数量，领取通过游戏邮件送达，回收每单位得2积分。原商城和排行尚未接入。</p>
                  {!matchesGameCharacter && <p className="activity-center__muted">请从这个角色的游戏大厅点击“活动”，再打开原版月光宝盒。</p>}</>}
                {selected.id === "gypsy" && <><button type="button" className="activity-center__button" disabled={locked || !matchesGameCharacter}
                  onClick={() => { void openNative("gypsy"); }}>试用原版吉普赛商人</button>
                  <p className="activity-center__muted">原窗口仍在测试。原窗刷新8件、网页刷新3件，两边共用货架和售罄状态，打开只读取。每天首次刷新免费，此后5积分；每件商品按显示数量整包购买，奖励通过游戏邮件送达。顶部展示本地普通材料。</p>
                  {!matchesGameCharacter && <p className="activity-center__muted">请从这个角色的游戏大厅点击“活动”，再打开原版吉普赛商人。</p>}</>}
                <section className="activity-center__rules"><h4>玩法说明</h4><ul>{selected.rules.map((rule, index) => <li key={index}>{rule}</li>)}</ul></section>
              </> : <p className="activity-center__empty">当前没有开放的活动。</p>}
            </section>
          </div>

          <details className="activity-center__history"><summary>最近活动记录</summary>
            {snapshot.history.length ? <ul>{snapshot.history.map((entry, index) => <li key={index}>{entry}</li>)}</ul> : <p>还没有活动记录。</p>}
          </details>
        </>}
      </div>
      <footer className="activity-center__footer"><span>本地活动 · 每日北京时间08:00刷新</span><span>{busy ? "提交中，重复点击已暂停" : "Esc 关闭 · 返回游戏邮箱查看奖励"}</span></footer>
    </dialog>
  );
}
