"""统计打包产物各部分体积, 定位优化点"""
import os
from pathlib import Path

ROOT = Path(r'D:\deepseek-harness-desktop\dist\win-unpacked')


def dir_size(p: Path) -> int:
    total = 0
    for dirpath, _, files in os.walk(p):
        for f in files:
            try:
                total += (Path(dirpath) / f).stat().st_size
            except OSError:
                pass
    return total


def mb(n: int) -> str:
    return f'{n / 1048576:8.1f} MB'


print('== win-unpacked 顶层 ==')
for item in sorted(ROOT.iterdir()):
    if item.is_file():
        print(f'{mb(item.stat().st_size)}  {item.name}')
    else:
        print(f'{mb(dir_size(item))}  {item.name}/')

print('\n== runtime 分解 ==')
rt = ROOT / 'resources' / 'runtime'
for item in sorted(rt.iterdir()):
    print(f'{mb(dir_size(item))}  {item.name}/')

print('\n== dsh/node_modules 大头 (top 20) ==')
nm = rt / 'dsh' / 'node_modules'
sizes = []
for item in nm.iterdir():
    if item.name.startswith('@'):
        for sub in item.iterdir():
            sizes.append((dir_size(sub), f'{item.name}/{sub.name}'))
    else:
        sizes.append((dir_size(item), item.name))
for size, name in sorted(sizes, reverse=True)[:20]:
    print(f'{mb(size)}  {name}')

print('\n== node 运行时分项 ==')
nd = rt / 'node'
for item in sorted(nd.iterdir()):
    if item.is_file():
        print(f'{mb(item.stat().st_size)}  {item.name}')
    else:
        print(f'{mb(dir_size(item))}  {item.name}/')
