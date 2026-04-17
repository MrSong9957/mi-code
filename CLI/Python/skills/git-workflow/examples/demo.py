"""示例：使用 git-workflow 技能的完整流程。"""

import subprocess


def create_feature_branch(name: str) -> None:
    subprocess.run(["git", "checkout", "main"])
    subprocess.run(["git", "pull"])
    subprocess.run(["git", "checkout", "-b", f"feat/{name}"])


if __name__ == "__main__":
    create_feature_branch("my-feature")
