/**
 * 混剪工作台：素材库里的视频/图片，按目标时长、节奏和防重复规则，生成一条可继续编辑的时间线。
 *
 * 面板只负责收参数和预览统计；真正的切点、洗牌、旁白时长和帧对齐都在 lib/mix-plan 里算，
 * 所以同一个 seed 在面板里看到的和落到时间线上的完全一致。
 */
import React from 'react';
import { Clapperboard, Layers, Loader2, Shuffle, Wand2 } from 'lucide-react';
import { useT } from '@/i18n';
import { mixableAssets, planMix, type MixAsset, type MixOptions, type MixPlan } from '@/lib/mix-plan';
import { Popover } from './Popover';

export type MixAspect = '9:16' | '16:9' | '1:1';

export interface MixRequest {
  plans: MixPlan[];
  options: MixOptions;
  aspect: MixAspect;
}

export interface MixPanelProps {
  assets: readonly MixAsset[];
  /** 当前选中的素材；为空时用素材库里全部可剪素材。 */
  chosen?: readonly MixAsset[];
  onMix: (request: MixRequest) => Promise<void> | void;
  /** 补探时长和尺寸：素材库列表只有路径和名字。 */
  onProbe?: (assets: MixAsset[]) => Promise<MixAsset[]>;
  /** 项目当前的画布，作为面板里比例预览的基准。 */
  stage: { w: number; h: number };
  fps: number;
}

const ASPECTS: Array<{ value: MixAspect; label: string }> = [
  { value: '9:16', label: '9:16 竖屏' },
  { value: '16:9', label: '16:9 横屏' },
  { value: '1:1', label: '1:1 方形' },
];

const PACES: Array<{ value: MixOptions['pace']; label: string }> = [
  { value: 'fast', label: '快剪' },
  { value: 'normal', label: '标准' },
  { value: 'slow', label: '舒缓' },
];

/** 比例对应的画布：短边保持 1080，和 Studio 的 canvasFor 一致。 */
export function stageForAspect(aspect: MixAspect): { w: number; h: number } {
  if (aspect === '16:9') return { w: 1920, h: 1080 };
  if (aspect === '1:1') return { w: 1080, h: 1080 };
  return { w: 1080, h: 1920 };
}

const fmt = (seconds: number) => (seconds >= 60
  ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
  : `${seconds.toFixed(1)}s`);

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2 text-[12px] font-medium text-[var(--text)]">
        {label}
        {hint ? <span className="text-[11px] font-normal text-[var(--text-faint)]">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

const INPUT = 'h-8 w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-[12.5px] text-[var(--text)] outline-none transition hover:border-[var(--border-strong)] focus:border-[var(--accent)]';

export function MixPanel({ assets, chosen = [], onMix, onProbe, fps }: MixPanelProps) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState(20);
  const [pace, setPace] = React.useState<MixOptions['pace']>('normal');
  const [avoidRepeat, setAvoidRepeat] = React.useState(3);
  const [shuffle, setShuffle] = React.useState(true);
  const [voice, setVoice] = React.useState('');
  const [aspect, setAspect] = React.useState<MixAspect>('9:16');
  const [batch, setBatch] = React.useState(1);
  const [seed, setSeed] = React.useState(() => Math.floor(Math.random() * 900000) + 1000);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [probed, setProbed] = React.useState<MixAsset[] | null>(null);
  const [probing, setProbing] = React.useState(false);
  React.useEffect(() => {
    if (!open || !onProbe) return;
    let live = true;
    setProbing(true);
    void onProbe([...assets]).then((list) => { if (live) setProbed(list); }).finally(() => { if (live) setProbing(false); });
    return () => { live = false; };
  }, [open, assets, onProbe]);

  const pool = probed ?? assets;
  const chosenPool = React.useMemo(() => (chosen.length ? chosen.map((c) => pool.find((p) => p.path === c.path) ?? c) : []), [chosen, pool]);
  const usable = React.useMemo(() => mixableAssets(chosenPool.length ? chosenPool : pool), [chosenPool, pool]);
  const key = React.useMemo(() => usable.map((a) => [a.path, a.durationMs ?? 0, a.w ?? 0, a.h ?? 0].join(':')).join('|'), [usable]);
  React.useEffect(() => { if (!open || !onProbe || probing) return; setProbed(null); }, [key]);
  const voiceSeconds = Number(voice);
  const options = React.useMemo<MixOptions>(() => ({
    targetSeconds: target,
    minShotSeconds: 1.2,
    maxShotSeconds: 3.6,
    pace,
    avoidRepeat,
    shuffle,
    seed,
    stage: stageForAspect(aspect),
    fps,
    ...(voiceSeconds > 0 ? { voiceSeconds } : {}),
  }), [target, pace, avoidRepeat, shuffle, seed, aspect, fps, voiceSeconds]);

  const preview = React.useMemo<{ plan: MixPlan | null; error: string | null }>(() => {
    if (!usable.length) return { plan: null, error: t('mix.noAssets') };
    try {
      return { plan: planMix(usable, options), error: null };
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [usable, options, t]);

  const run = async () => {
    if (!usable.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const plans = Array.from({ length: Math.max(1, Math.min(12, batch)) }, (_, i) => planMix(usable, {
        ...options,
        seed: seed + i * 7919,
      }));
      await onMix({ plans, options, aspect });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const repeats = preview.plan ? preview.plan.shots - Object.keys(preview.plan.used).length : 0;
  const count = Math.max(1, Math.min(12, batch));

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      placement="auto"
      align="start"
      trigger={(
        <button type="button" aria-label={t('mix.title')} title={t('mix.title')}
          className="flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-[var(--accent)] transition hover:bg-[var(--bg-hover)]">
          <Wand2 size={14} />
          <span className="hidden @min-[420px]:inline">{t('mix.short')}</span>
        </button>
      )}
    >
      <div className="flex max-h-[min(78vh,720px)] w-[352px] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]">
        <div className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--fill-tsp)] text-[var(--accent)]"><Clapperboard size={16} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-[var(--text)]">{t('mix.title')}</div>
            <div className="text-[11.5px] text-[var(--text-faint)]">
              {chosen.length ? t('mix.scopeChosen').replace('{n}', String(usable.length)) : t('mix.scopeAll').replace('{n}', String(usable.length))}
            </div>
          </div>
          <span className="rounded-full bg-[var(--fill-tsp)] px-2 py-0.5 text-[10.5px] tabular-nums text-[var(--text-muted)]">{fps} fps</span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={t('mix.target')} hint={voiceSeconds > 0 ? t('mix.voiceWins') : 's'}>
              <input type="number" min={2} max={600} step={1} value={target} disabled={voiceSeconds > 0}
                onChange={(e) => setTarget(Math.max(2, Math.min(600, Number(e.target.value) || 2)))} className={INPUT} />
            </Field>
            <Field label={t('mix.voice')} hint={t('mix.optional')}>
              <input type="number" min={0} max={600} step={0.1} value={voice} placeholder="0"
                onChange={(e) => setVoice(e.target.value)} className={INPUT} />
            </Field>
          </div>

          <Field label={t('mix.pace')}>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-[var(--fill-tsp)] p-1">
              {PACES.map((p) => (
                <button key={p.value} type="button" onClick={() => setPace(p.value)}
                  className={`h-7 rounded-md text-[12px] transition ${pace === p.value ? 'bg-[var(--dock-pane)] font-medium text-[var(--text)] shadow-sm ring-1 ring-[var(--border)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label={t('mix.aspect')}>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-[var(--fill-tsp)] p-1">
              {ASPECTS.map((a) => (
                <button key={a.value} type="button" onClick={() => setAspect(a.value)}
                  className={`h-7 rounded-md text-[11.5px] transition ${aspect === a.value ? 'bg-[var(--dock-pane)] font-medium text-[var(--text)] shadow-sm ring-1 ring-[var(--border)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
                  {a.label}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-2.5">
            <Field label={t('mix.avoid')} hint={t('mix.shots')}>
              <input type="number" min={0} max={20} step={1} value={avoidRepeat}
                onChange={(e) => setAvoidRepeat(Math.max(0, Math.min(20, Number(e.target.value) || 0)))} className={INPUT} />
            </Field>
            <Field label={t('mix.batch')} hint={t('mix.batchHint')}>
              <input type="number" min={1} max={12} step={1} value={batch}
                onChange={(e) => setBatch(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} className={INPUT} />
            </Field>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] px-2.5 py-2">
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]"><Shuffle size={13} />{t('mix.shuffle')}</span>
            <button type="button" role="switch" aria-checked={shuffle} aria-label={t('mix.shuffle')} onClick={() => setShuffle((v) => !v)}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${shuffle ? 'bg-[var(--text)]' : 'bg-[var(--surface-3)]'}`}>
              <span className={`absolute top-[2px] h-4 w-4 rounded-full bg-[var(--bg)] shadow transition-all ${shuffle ? 'left-[18px]' : 'left-[2px]'}`} />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11.5px] text-[var(--text-faint)]">{t('mix.seed')}</span>
            <input type="number" min={1} value={seed} onChange={(e) => setSeed(Math.max(1, Number(e.target.value) || 1))}
              className={`${INPUT} flex-1 tabular-nums`} />
            <button type="button" onClick={() => setSeed(Math.floor(Math.random() * 900000) + 1000)}
              className="h-8 shrink-0 rounded-md border border-[var(--border)] px-2 text-[11.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
              {t('mix.reroll')}
            </button>
          </div>

          <div className="rounded-lg bg-[var(--fill-tsp)] px-3 py-2.5">
            {preview.plan ? (
              <>
                <div className="flex items-center justify-between text-[12px]">
                  <span className="flex items-center gap-1.5 font-medium text-[var(--text)]"><Layers size={13} />{t('mix.preview')}</span>
                  <span className="tabular-nums text-[var(--text-muted)]">{fmt(preview.plan.durationSeconds)}</span>
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-1 text-[11px] text-[var(--text-muted)]">
                  <span>{t('mix.shotCount').replace('{n}', String(preview.plan.shots))}</span>
                  <span>{t('mix.assetCount').replace('{n}', String(Object.keys(preview.plan.used).length))}</span>
                  <span>{t('mix.reuse').replace('{n}', String(repeats))}</span>
                </div>
                <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-[var(--border)]" aria-hidden>
                  {preview.plan.segments.map((s, i) => (
                    <span key={`${s.src}-${i}`} className="h-full border-r border-[var(--surface)] last:border-r-0"
                      style={{ width: `${(s.length / Math.max(0.01, preview.plan!.durationSeconds)) * 100}%`, opacity: 0.35 + ((i * 37) % 60) / 100 }} />
                  ))}
                </div>
              </>
            ) : <span className="text-[11.5px] text-[var(--err)]">{preview.error ?? t('mix.noAssets')}</span>}
          </div>
          {error ? <span className="text-[11.5px] text-[var(--err)]">{error}</span> : null}
        </div>

        <div className="border-t border-[var(--border)] px-4 py-3">
          <button type="button" disabled={!preview.plan || busy || probing} onClick={() => void run()}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[var(--text)] text-[13px] font-semibold text-[var(--bg)] transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-45">
            {busy || probing ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
            {count > 1 ? t('mix.generateBatch').replace('{n}', String(count)) : t('mix.generate')}
          </button>
          <p className="mt-1.5 text-center text-[10.5px] leading-relaxed text-[var(--text-faint)]">{t('mix.note')}</p>
        </div>
      </div>
    </Popover>
  );
}
