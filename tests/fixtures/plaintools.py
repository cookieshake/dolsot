"""plaintools — a toolbox with no __all__, no help(), and an exception with no
exit_code. dolsot must degrade gracefully, not break."""


class PlainError(Exception):
    pass


def ping():
    return "pong"


def bang():
    raise PlainError("bang")
