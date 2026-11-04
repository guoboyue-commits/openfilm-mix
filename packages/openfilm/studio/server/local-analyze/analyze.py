# -*- coding: utf-8 -*-
"""OpenFilm Studio 的本地素材识别：ffmpeg 取帧 + faster-whisper 转写。

不联网、不调用云端 API。输出给 Node 端的是 JSON：
  { ok, model, duration, segments: [{start,end,text,speech,tags}], tags, notes }
画面部分是本机可解释的画面特征（镜头切换、亮度、色彩、清晰度、运动量），
不是语义级视觉理解；台词来自本地 Whisper 模型。
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

W, H = 48, 27
SAMPLE_FPS = 6.0
MAX_SAMPLES = 1800


def run(cmd, timeout=600):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or b'').decode('utf-8', 'replace')[-800:])
    return p.stdout


def ffprobe(path):
    out = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', str(path)])
    data = json.loads(out.decode('utf-8', 'replace') or '{}')
    duration = float((data.get('format') or {}).get('duration') or 0)
    has_audio = any(s.get('codec_type') == 'audio' for s in data.get('streams') or [])
    return duration, has_audio


def sample_frames(path, duration):
    """按固定采样率缩成 48x27 RGB 小图，一次 ffmpeg 调用读完。"""
    fps = SAMPLE_FPS
    if duration > MAX_SAMPLES / fps:
        fps = max(1.0, MAX_SAMPLES / max(duration, 1))
    raw = run(['ffmpeg', '-v', 'error', '-i', str(path), '-an', '-vf', f'fps={fps:.4f},scale={W}:{H}:flags=area',
               '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], timeout=900)
    size = W * H * 3
    n = len(raw) // size
    return fps, [raw[i * size:(i + 1) * size] for i in range(n)]


def stats_of(buf):
    lum = [0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2] for i in range(0, len(buf), 3)]
    mean = sum(lum) / len(lum)
    var = sum((v - mean) ** 2 for v in lum) / len(lum)
    # 边缘（清晰度）：相邻像素亮度差
    edge = 0.0
    for y in range(H):
        row = y * W
        for x in range(1, W):
            edge += abs(lum[row + x] - lum[row + x - 1])
    edge /= (H * (W - 1))
    # 主色：量化到 4 级后取最多的桶
    buckets = {}
    for i in range(0, len(buf), 3):
        key = (buf[i] // 64, buf[i + 1] // 64, buf[i + 2] // 64)
        buckets[key] = buckets.get(key, 0) + 1
    rk = max(buckets, key=buckets.get)
    # 画面重心（亮度加权）
    sx = sy = sw = 0.0
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            v = lum[y * W + x]
            sx += x * v; sy += y * v; sw += v
    cx = sx / sw / W if sw else 0.5
    cy = sy / sw / H if sw else 0.5
    # 元素密度：偏离平均亮度够远的像素占比。高 = 画面碎、细节多；低 = 大面积纯色/留白
    sd = math.sqrt(var)
    far = sum(1 for v in lum if abs(v - mean) > max(18.0, sd)) / len(lum)
    return {'lum': mean, 'contrast': sd, 'edge': edge, 'rgb': tuple(c * 64 + 32 for c in rk),
            'cx': cx, 'cy': cy, 'spread': far, 'lum_map': lum}


def diff(a, b):
    """两帧 RGB 的平均差（0..1）。比只看亮度敏感：暗场换镜也能看出来。"""
    s = 0
    for i in range(0, len(a), 3):
        s += abs(a[i] - b[i]) + abs(a[i + 1] - b[i + 1]) + abs(a[i + 2] - b[i + 2])
    return s / (len(a) / 3) / 765.0


def color_name(rgb):
    r, g, b = rgb
    mx, mn = max(rgb), min(rgb)
    if mx < 55: return '深色'
    if mn > 205 and mx - mn < 22: return '白色'
    if mx - mn < 26: return '灰调' if mx < 170 else '浅灰'
    if r >= g and r >= b:
        return '暖橙红' if g > b + 18 else ('粉紫' if b > g + 18 else '红色')
    if g >= r and g >= b:
        return '青绿' if b > r + 18 else '绿色'
    return '蓝色' if g > r + 18 else '紫蓝'


def brightness_name(lum):
    if lum < 55: return '偏暗'
    if lum < 110: return '中等亮度'
    if lum < 180: return '明亮'
    return '高亮'


def sharp_name(edge):
    if edge < 6: return '柔和虚化'
    if edge < 16: return '清晰'
    return '细节锐利'


def contrast_name(contrast):
    """反差：同一亮度基准下，画面里最亮和最暗拉得开不开。"""
    if contrast < 26: return '低反差'
    if contrast > 72: return '强反差'
    return None


def density_name(spread):
    """元素密度：画面是碎还是干净。比“清晰/虚化”更能区分不同镜头。"""
    if spread > 0.34: return '画面元素多'
    if spread < 0.12: return '画面简洁'
    return None


def drift_name(stats):
    """主体位移：整段首尾重心差。镜头基本不动时这一段就不写，免得每段都是同一句。"""
    if len(stats) < 3:
        return None
    dx = stats[-1]['cx'] - stats[0]['cx']
    dy = stats[-1]['cy'] - stats[0]['cy']
    if abs(dx) < 0.12 and abs(dy) < 0.12:
        return None
    if abs(dx) >= abs(dy):
        return '主体右移' if dx > 0 else '主体左移'
    return '主体下移' if dy > 0 else '主体上移'


def position_name(cx, cy):
    x = '左侧' if cx < 0.38 else ('右侧' if cx > 0.62 else '居中')
    y = '偏上' if cy < 0.38 else ('偏下' if cy > 0.62 else '中部')
    return f'{x}{y}'


def shot_notes(stats):
    """把一段镜头的画面特征写成一句人能看懂的话。"""
    lums = [s['lum'] for s in stats]
    edges = [s['edge'] for s in stats]
    avg_lum = sum(lums) / len(lums)
    avg_edge = sum(edges) / len(edges)
    if len(lums) > 3:
        trend = lums[-1] - lums[0]
    else:
        trend = 0
    mid = stats[len(stats) // 2]
    parts = [brightness_name(avg_lum), sharp_name(avg_edge)]
    if color_name(mid['rgb']) not in ('灰调', '浅灰'):
        parts.append(color_name(mid['rgb']))
    # 反差 / 元素密度：同一支片子里不同镜头的这两项差别最大，最能拉开描述
    for extra in (contrast_name(sum(s['contrast'] for s in stats) / len(stats)),
                  density_name(sum(s['spread'] for s in stats) / len(stats))):
        if extra:
            parts.append(extra)
    # 主体位置：整段平均重心
    cx = sum(s['cx'] for s in stats) / len(stats)
    cy = sum(s['cy'] for s in stats) / len(stats)
    parts.append('主体' + position_name(cx, cy))
    if trend > 28: parts.append('由暗转亮')
    elif trend < -28: parts.append('由亮转暗')
    drift = drift_name(stats)
    if drift:
        parts.append(drift)
    # 运动：帧间差
    motions = [diff(stats[i]['lum_map'], stats[i - 1]['lum_map']) for i in range(1, len(stats))]
    motion = sum(motions) / len(motions) if motions else 0
    if motion > 0.16: parts.append('画面变化快')
    elif motion > 0.07: parts.append('画面持续运动')
    else: parts.append('画面较稳')
    return '，'.join(parts)


def detect_cuts(frames, duration, fps, min_shot=1.2):
    """镜头切换：帧差先平滑，再按全片的中位数/MAD 定自适应阈值。

    暗场、低对比的成片里，固定的绝对阈值会一段都切不出来；按全片噪声水平定阈值更稳。
    相邻切换至少隔 1.2 秒，最多 24 段，避免把连续运动切碎。
    """
    cuts = [0.0]
    n = len(frames)
    # 镜头切得越细，越要防止把连续运动切碎：最短镜头不低于 0.45s
    min_shot = max(0.45, float(min_shot))
    if n < 5:
        return cuts
    d = [0.0] + [diff(frames[i], frames[i - 1]) for i in range(1, n)]
    smooth = []
    for i in range(n):
        part = d[max(0, i - 1):min(n, i + 2)]
        smooth.append(sum(part) / len(part))
    ordered = sorted(smooth)
    med = ordered[len(ordered) // 2]
    mad = sorted(abs(x - med) for x in smooth)[len(smooth) // 2] or 0.001
    # 镜头切换是少数几帧的尖峰：中位数/MAD 会被连续运动抬高，
    # 所以阈值取「噪声水平」和「第 99 百分位 × 0.4」里更低的那个
    peak = ordered[min(len(ordered) - 1, int(len(ordered) * 0.99))] if len(ordered) > 8 else ordered[-1]
    threshold = min(max(0.022, med + 5.0 * mad * 1.4826), max(0.022, peak * 0.4))
    # 最后一帧也要看：成片常常正好在片尾切一刀
    for i in range(1, n):
        t = i / fps
        if t - cuts[-1] < min_shot or t > duration - 0.01:
            continue
        nxt = smooth[i + 1] if i + 1 < n else 0.0
        if smooth[i] >= threshold and smooth[i] >= smooth[i - 1] and smooth[i] >= nxt:
            cuts.append(round(t, 2))
            if len(cuts) >= 60:
                break
    # 片尾那一刀也算（成片常常正好在片尾切），只跳过最后一帧
    last = n - 1
    if last > 0 and last / fps - cuts[-1] >= min_shot and smooth[last] > threshold * 1.5:
        cuts.append(round(last / fps, 2))
    return cuts

frames_fps = SAMPLE_FPS


def split_sentences(text):
    """把 Whisper 的一大段按句号/问号/感叹号切开（逗号太碎，留在句子里）。"""
    parts = re.findall(r'[^。！？!?]+[。！？!?]?', text)
    return [p.strip() for p in parts if p.strip()]


MODELS = {}
# 模型文件坏了或没下完时，退回本机已有的档位，而不是让整条识别失败。
FALLBACK = {'large-v3': 'medium', 'large-v2': 'medium', 'medium': 'small', 'small': 'base', 'base': 'tiny'}


def pick_model(model_size):
    """按顺序试：想要的档位 → 更小的档位。只认可解析到的模型，不全就往下走。"""
    from faster_whisper import WhisperModel
    wanted = model_size or 'small'
    tried = []
    name = wanted
    while name:
        if name not in MODELS:
            try:
                MODELS[name] = WhisperModel(name, device='cpu', compute_type='int8')
            except Exception as e:  # noqa: BLE001
                tried.append(f'{name}: {e}')
                name = FALLBACK.get(name)
                continue
        return MODELS[name], name, tried
    raise RuntimeError('没有可用的 Whisper 模型：' + '; '.join(tried))


MIRROR = os.environ.get('OPENFILM_HF_MIRROR', 'https://hf-mirror.com')


def fetch_model(model_size='small', mirror=None):
    """把模型下载进 Hugging Face 缓存（默认走国内镜像）。已下完的文件不会重下。

    国内直连 huggingface.co 常常超时；模型是一次性成本，下好之后识别完全离线。
    """
    from huggingface_hub import hf_hub_download
    repo = model_size if '/' in model_size else f'Systran/faster-whisper-{model_size}'
    short = repo.split('/')[-1].replace('faster-whisper-', '')
    base = (mirror or MIRROR).rstrip('/')
    files = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt']
    got = {}
    for name in files:
        got[name] = hf_hub_download(repo_id=repo, filename=name, endpoint=base)
    return {'ok': True, 'model': short, 'files': got}

def whisper_model(model_size):
    """本机 Whisper 模型只加载一次：常驻进程里每批复用，省掉十几秒的启动时间。"""
    return pick_model(model_size)[0]


def transcribe(path, language, model_size):
    model, used, tried = pick_model(model_size)
    segs, info = model.transcribe(str(path), language=language, vad_filter=True, beam_size=1,
                                  condition_on_previous_text=False,
                                  initial_prompt='以下是普通话的句子，关于产品介绍和卖点。')
    out = []
    for s in segs:
        text = re.sub(r'\s+', ' ', (s.text or '')).strip()
        if not text:
            continue
        # Whisper 一段常有好几句：按句子拆开，时间按字数比例分，时间线才定位得准
        sentences = split_sentences(text)
        total = sum(len(x) for x in sentences) or 1
        at = float(s.start)
        span = max(0.0, float(s.end) - float(s.start))
        for line in sentences:
            take = span * len(line) / total
            out.append({'start': round(at, 2), 'end': round(at + take, 2), 'text': line})
            at += take
    return out, getattr(info, 'language', language), used, tried

def cues_of(path, language, model_size):
    """只做台词：把一条配音/音频转成逐句 {text,start,end}，给字幕用。

    旧版本生成的配音没有 wav 旁边的 .cues.json，烧字幕时就用它现场对齐一次。
    只读音频、不抽帧，比完整识别快得多。
    """
    speech, lang, used, tried = transcribe(path, language, model_size)
    cues = [{'text': one['text'], 'start': round(float(one['start']), 3), 'end': round(float(one['end']), 3)}
            for one in speech if one.get('text') and float(one['end']) > float(one['start'])]
    return {'ok': True, 'language': lang, 'model': used, 'fallbacks': tried, 'cues': cues}

def clock(seconds):
    """时间线用的时间码：0:00 / 1:28.50（和 Node 端 timelineText 一致）。"""
    t = max(0.0, float(seconds))
    m = int(t // 60)
    rest = round(t - m * 60, 2)
    if abs(rest - round(rest)) < 1e-9:
        return f'{m}:{int(round(rest)):02d}'
    return f'{m}:{rest:05.2f}'


def merge_speech(speech, start, end):
    words = [s['text'] for s in speech if s['start'] >= start - 0.05 and s['start'] < end - 0.05]
    return ' '.join(words).strip()


def _trim_dark_head(stats, a, b, fps):
    """把段落开头那截黑场/渐亮推掉：从黑场开始到画面真正出现为止。

    片头淡入本来是黑的，但从黑场直接取段会让成片出现一段 0.5-1 秒的空白。
    只有当开头确实接近全黑（亮度低且几乎没有细节）时才推进；正常的暗色画面不动。
    """
    ia = max(0, min(len(stats) - 1, int(round(a * fps))))
    ib = max(ia + 1, min(len(stats), int(round(b * fps))))
    if ib - ia < 2:
        return a
    # 开头连续的黑帧：亮度很低且几乎没有细节变化
    # 只要画面亮度极低或几乎全黑（无论从纯黑开始还是从暗灰淡入），都推到画面基本成形
    def is_fade_in_dark(frame):
        # 纯黑（lum<12）或极暗且无对比（lum<20 且 contrast<6 且 spread<0.05，或淡黑 lum<25 且 contrast<3 且 spread<0.02）
        return frame['lum'] < 12 or (frame['lum'] < 20 and frame['contrast'] < 6 and frame['spread'] < 0.05) or (frame['lum'] < 25 and frame['contrast'] < 3.0 and frame['spread'] < 0.02)
    first = ia
    while first < ib and is_fade_in_dark(stats[first]):
        first += 1
    if first == ia:
        return a
    if first >= ib:
        return a
    trimmed = round(first / fps, 2)
    return trimmed if trimmed - a < min(2.5, (b - a) * 0.4) else a


def build(path, language, model_size, skip_speech, min_shot=1.2, want_quality=True):
    duration, has_audio = ffprobe(path)
    global frames_fps
    frames_fps, raws = sample_frames(path, duration)
    stats = [stats_of(b) for b in raws]
    if skip_speech or not has_audio:
        speech, lang, used, tried = [], language, None, []
    else:
        speech, lang, used, tried = transcribe(path, language, model_size)
    cuts = detect_cuts(raws, duration, frames_fps, min_shot)
    bounds = cuts + [round(duration, 2)]
    # 一个镜头里说了很多句时，按句子的起点再切一刀：时间线更像字幕，也更好定位
    if speech:
        extra = []
        for i in range(len(bounds) - 1):
            a, b = bounds[i], bounds[i + 1]
            if b - a <= 6.0:
                continue
            for line in speech:
                t = line['start']
                if t - a >= 1.5 and b - t >= 1.5:
                    extra.append(round(t, 2))
        if extra:
            bounds = sorted(set(bounds + extra))
    # 片尾不到 0.3s 的碎段并回上一段：成片最后几帧常常正好是一个转场，
    # 单独成段只会出现「7.83-8.00s」这种没信息量的尾巴
    if len(bounds) > 2 and bounds[-1] - bounds[-2] < 0.3:
        bounds = bounds[:-2] + [bounds[-1]]
    segments = []
    for i in range(len(bounds) - 1):
        a, b = bounds[i], bounds[i + 1]
        if b - a < 0.3:
            continue
        # 段首黑场/渐亮推掉：否则成片按这段取画面会带一段空白
        a = _trim_dark_head(stats, a, b, frames_fps)
        if b - a < 0.3:
            continue
        ia = min(len(stats) - 1, int(a * frames_fps))
        ib = max(ia + 1, min(len(stats), int(b * frames_fps)))
        shot = stats[ia:ib]
        note = shot_notes(shot)
        said = merge_speech(speech, a, b)
        # 台词太长时按句号/逗号切短，读起来像字幕
        text = ('口播解说，' + note) if said else note
        tags = []
        if said: tags.append('口播')
        if any(k in note for k in ('偏暗', '高亮')): tags.append('明暗对比')
        if '变化快' in note: tags.append('快切')
        if '较稳' in note: tags.append('稳定镜头')
        if '锐利' in note: tags.append('特写')
        segments.append({'start': round(a, 2), 'end': round(b, 2), 'text': text, 'speech': said or None, 'tags': tags})
    # 成片质检：黑帧/静音/抖动/分辨率，时间精确到 0.01 秒
    quality = quality_of(path, duration, has_audio, stats, frames_fps) if want_quality else None
    return {'ok': True, 'duration': round(duration, 2), 'language': lang, 'hasAudio': has_audio,
            'model': used, 'fallbacks': tried,
            'speech': speech, 'segments': segments, 'quality': quality}


def _black_issue(issues, dark_at, dark, fps, duration, edge):
    """一段连续黑帧够长就记一条；片头片尾的淡入淡出不算。返回 0，方便调用处清零。"""
    if dark_at is None or dark < max(1, int(0.5 * fps)):
        return 0
    # dark_at 是 quality_of 里算好的秒数（i / fps），这里不能再除一次 fps；dark 才是帧数
    start = dark_at
    end = start + dark / fps
    if end <= edge or start >= duration - edge:
        return 0
    at = max(start, edge)
    span = min(end, duration) - at
    if span < 0.3:
        return 0
    issues.append({'code': 'black', 'level': 'error', 'at': round(at, 2), 'span': round(span, 2),
                   'text': f'{clock(at)} 起有 {span:.2f}s 黑帧（切点空档，给这段加淡入淡出）'})
    return 0


def quality_of(path, duration, has_audio, stats, fps):
    """成片质检：黑帧、静音、时长、画面稳定性、分辨率。全部在本机算，不联网。

    返回 {ok, issues:[{code, level, at?, span?, text}], metrics:{...}}。
    level: error（必须修）/ warn（建议看）/ info（只是记录）。
    """
    issues = []
    lums = [s['lum'] for s in stats] or [0.0]
    # 1) 黑帧：连续 >= 0.5s 亮度低于 12。
    #    首尾各留 0.6s：片头/片尾淡入淡出本来就是黑的，不按黑帧报。
    #    中间的黑帧多半是跨素材硬切留下的空档，按“切点黑帧”报，提示加淡入淡出。
    dark = 0
    dark_at = None
    edge = 0.6
    for i, lum in enumerate(lums):
        if lum < 12:
            if dark == 0:
                dark_at = i / fps
            dark += 1
        else:
            dark = _black_issue(issues, dark_at, dark, fps, duration, edge)
            dark = 0
    _black_issue(issues, dark_at, dark, fps, duration, edge)
    # 2) 静音：整条没有音轨，或有音轨但音量一直很低
    mean_db = None
    if not has_audio:
        issues.append({'code': 'no-audio', 'level': 'warn', 'text': '这条成片没有音轨'})
    else:
        mean_db = mean_volume(path)
        if mean_db is not None and mean_db < -50:
            issues.append({'code': 'silent', 'level': 'warn', 'text': f'整条几乎没声音（平均 {mean_db:.1f} dB）'})
    # 3) 时长
    if duration < 1.0:
        issues.append({'code': 'too-short', 'level': 'error', 'text': f'只有 {duration:.2f}s，太短'})
    # 4) 画面稳定性：帧间差过大说明抖动/闪
    motion = 0.0
    if len(stats) > 2:
        motion = sum(diff(stats[i]['lum_map'], stats[i - 1]['lum_map']) for i in range(1, len(stats))) / (len(stats) - 1)
        if motion > 0.30:
            issues.append({'code': 'jitter', 'level': 'warn', 'text': f'画面整体抖动偏大（帧差 {motion:.2f}）'})
    # 5) 分辨率
    w, h = probe_size(path)
    if w and h and min(w, h) < 720:
        issues.append({'code': 'low-res', 'level': 'warn', 'text': f'分辨率偏低：{w}x{h}'})
    return {'ok': not any(i['level'] == 'error' for i in issues), 'issues': issues,
            'metrics': {'duration': round(duration, 2), 'width': w, 'height': h, 'hasAudio': has_audio,
                        'meanVolumeDb': None if not has_audio else mean_db, 'motion': round(motion, 3),
                        'darkRatio': round(sum(1 for x in lums if x < 12) / max(1, len(lums)), 3)}}


def probe_size(path):
    try:
        out = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                   '-of', 'json', str(path)])
        data = json.loads(out.decode('utf-8', 'replace') or '{}')
        st = (data.get('streams') or [{}])[0]
        return int(st.get('width') or 0), int(st.get('height') or 0)
    except Exception:  # noqa: BLE001
        return 0, 0


def mean_volume(path):
    """整条音轨的平均音量（dB）；读不出来返回 None。"""
    try:
        p = subprocess.run(['ffmpeg', '-v', 'info', '-i', str(path), '-af', 'volumedetect', '-f', 'null', '-'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
        text = (p.stderr or b'').decode('utf-8', 'replace')
        m = re.search(r'mean_volume:\s*(-?[\d.]+) dB', text)
        return float(m.group(1)) if m else None
    except Exception:  # noqa: BLE001
        return None


def run_jobs(jobs, language, model_size, skip_speech, on_done=None, min_shot=1.2, quality=True):
    """识别一批；每条完成就回调一次（常驻进程用它把进度报给 Studio）。"""
    result = {'ok': True, 'results': []}
    for job in jobs:
        try:
            one = build(Path(job['path']), language, model_size, skip_speech, min_shot, quality)
            one['path'] = job.get('path')
        except Exception as e:  # noqa: BLE001
            one = {'ok': False, 'path': job.get('path'), 'error': str(e)}
        result['results'].append(one)
        if on_done:
            on_done(one)
    return result


# Windows 控制台默认 GBK：和 Node / 调用方之间固定用 UTF-8，台词才不会变成乱码
try:
    sys.stdin.reconfigure(encoding='utf-8', errors='replace')
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:  # noqa: BLE001
    pass

def serve():
    """常驻模式：一行一个请求（JSON），一行一个事件（JSON）。

    请求 {'id', 'jobs': [{'path'}], 'language', 'model', 'skipSpeech'}；
    事件 {'id', 'type': 'progress'|'done'|'error', ...}。
    模型在第一次需要台词时才加载，之后一直留在进程里。
    """
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception as e:  # noqa: BLE001
            sys.stdout.write(json.dumps({'type': 'error', 'error': f'bad request: {e}'}, ensure_ascii=False) + '\n')
            sys.stdout.flush()
            continue
        rid = req.get('id')
        jobs = req.get('jobs') or []
        language = req.get('language') or 'zh'
        model_size = req.get('model') or 'small'
        skip = bool(req.get('skipSpeech'))
        min_shot = float(req.get('minShot') or 1.2)
        want_quality = req.get('quality') is not False

        def send(event):
            event['id'] = rid
            sys.stdout.write(json.dumps(event, ensure_ascii=False) + '\n')
            sys.stdout.flush()

        def on_done(one):
            send({'type': 'progress', 'path': one.get('path'), 'ok': one.get('ok', True), 'error': one.get('error')})

        try:
            result = run_jobs(jobs, language, model_size, skip, on_done, min_shot, want_quality)
            send({'type': 'done', 'result': result})
        except Exception as e:  # noqa: BLE001
            send({'type': 'error', 'error': str(e)})
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input', nargs='?', default='')
    ap.add_argument('--language', default='zh')
    ap.add_argument('--skip-speech', action='store_true')
    ap.add_argument('--model', default='small')
    ap.add_argument('--batch', action='store_true')
    ap.add_argument('--serve', action='store_true')
    ap.add_argument('--cues', action='store_true')
    ap.add_argument('--jobs', default='')
    ap.add_argument('--out')
    ap.add_argument('--fetch-model', nargs='?', const='small', default=None,
                        help='下载识别模型到本机缓存（默认 small，走国内镜像），下完就离线可用')
    ap.add_argument('--mirror', default=None, help='模型下载镜像，默认 https://hf-mirror.com')
    args = ap.parse_args()
    if args.serve:
        return serve()
    if args.fetch_model:
        try:
            result = fetch_model(args.fetch_model, args.mirror)
        except Exception as e:  # noqa: BLE001
            result = {'ok': False, 'error': f'{type(e).__name__}: {e}'}
        body = json.dumps(result, ensure_ascii=False)
        if args.out:
            Path(args.out).write_text(body, encoding='utf-8')
        else:
            sys.stdout.write(body)
        return 0 if result.get('ok') else 1
    try:
        if args.cues:
            result = cues_of(Path(args.input), args.language, args.model)
        elif args.batch:
            jobs = json.loads(Path(args.jobs).read_text(encoding='utf-8')) if args.jobs else json.loads(args.input)
            result = run_jobs(jobs, args.language, args.model, args.skip_speech)
        else:
            result = build(Path(args.input), args.language, args.model, args.skip_speech)
    except Exception as e:  # noqa: BLE001
        result = {'ok': False, 'error': str(e)}
    body = json.dumps(result, ensure_ascii=False)
    if args.out:
        Path(args.out).write_text(body, encoding='utf-8')
    else:
        sys.stdout.write(body)
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())

