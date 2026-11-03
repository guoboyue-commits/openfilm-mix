import importlib.util
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).with_name('analyze.py')

spec = importlib.util.spec_from_file_location('analyze', str(ROOT))
az = importlib.util.module_from_spec(spec)
spec.loader.exec_module(az)

failures = []

def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else ' :: ' + detail))
    if not cond:
        failures.append(name)


def frame(lum, contrast, spread):
    return {'lum': lum, 'contrast': contrast, 'spread': spread}


# 黑帧的时间必须是秒；dark 才是帧数
issues = []
az._black_issue(issues, 4.0, 4.2, 6.0, 20.0, 0.6)
check('black reported at 4.0s', bool(issues) and abs(issues[0]['at'] - 4.0) < 1e-6, str(issues))

# 黑帧一直拖到片尾：span 要按成片时长截断
issues = []
az._black_issue(issues, 19.2, 12, 6.0, 20.0, 0.6)
check('black span clipped to duration', bool(issues) and issues[0]['span'] <= 0.81, str(issues))

# 段首黑场/渐亮要被推掉
fade = [frame(15.2, 0.7, 0.0), frame(11.1, 4.1, 0.018), frame(8.5, 8.2, 0.039),
        frame(9.7, 19.4, 0.131), frame(20.2, 31.4, 0.16), frame(35.0, 43.0, 0.18)]
check('fade-in head trimmed', az._trim_dark_head(fade, 0.0, 3.0, 6.0) > 0.2,
      str(az._trim_dark_head(fade, 0.0, 3.0, 6.0)))

# 暗但有细节的画面不能被当成黑场
dark = [frame(18.0, 22.0, 0.18), frame(19.0, 23.0, 0.19), frame(20.0, 24.0, 0.2)]
check('dark but detailed shot kept', az._trim_dark_head(dark, 0.0, 1.5, 6.0) == 0.0)

# 淡黑（lum 22 / contrast 2.4 / spread 0）也要推掉：这是 A1-multi 首帧的老问题
faint = [frame(22.0, 2.4, 0.0), frame(23.5, 2.6, 0.0), frame(41.0, 30.0, 0.15), frame(52.0, 33.0, 0.17)]
check('faint dark head trimmed', az._trim_dark_head(faint, 0.0, 1.5, 6.0) > 0.1,
      str(az._trim_dark_head(faint, 0.0, 1.5, 6.0)))
# 整段全黑时不要推到没有画面
black = [frame(5.0, 0.5, 0.0)] * 8
check('all-black shot not pushed away', az._trim_dark_head(black, 0.0, 1.2, 6.0) == 0.0)

print()
print('failures:', len(failures))
sys.exit(1 if failures else 0)
