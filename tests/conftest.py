"""pytest 配置：将 cli/python 加入 sys.path，使测试能 import agent_loop。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "CLI" / "Python"))
