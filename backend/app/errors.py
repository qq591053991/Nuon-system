from fastapi import HTTPException


class BizError(HTTPException):
    """业务规则校验失败（返回 400 + 中文提示）。"""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(status_code=status_code, detail=message)


class NotFound(BizError):
    def __init__(self, what: str = "记录"):
        super().__init__(f"{what}不存在", status_code=404)
