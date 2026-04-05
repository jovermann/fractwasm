#!/usr/bin/env python3

from __future__ import annotations

import struct
from pathlib import Path


I32 = 0x7F
F64 = 0x7C
FUNC_TYPE = 0x60


def u32(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def s32(value: int) -> bytes:
    out = bytearray()
    more = True
    while more:
        byte = value & 0x7F
        value >>= 7
        sign_bit = byte & 0x40
        done = (value == 0 and sign_bit == 0) or (value == -1 and sign_bit != 0)
        if done:
            more = False
        else:
            byte |= 0x80
        out.append(byte)
    return bytes(out)


def f64(value: float) -> bytes:
    return struct.pack("<d", value)


def vec(items: list[bytes]) -> bytes:
    return u32(len(items)) + b"".join(items)


def name(text: str) -> bytes:
    raw = text.encode("utf-8")
    return u32(len(raw)) + raw


def section(section_id: int, payload: bytes) -> bytes:
    return bytes([section_id]) + u32(len(payload)) + payload


def local_get(index: int) -> bytes:
    return b"\x20" + u32(index)


def local_set(index: int) -> bytes:
    return b"\x21" + u32(index)


def i32_const(value: int) -> bytes:
    return b"\x41" + s32(value)


def f64_const(value: float) -> bytes:
    return b"\x44" + f64(value)


def block() -> bytes:
    return b"\x02\x40"


def loop() -> bytes:
    return b"\x03\x40"


def br(depth: int) -> bytes:
    return b"\x0C" + u32(depth)


def br_if(depth: int) -> bytes:
    return b"\x0D" + u32(depth)


def end() -> bytes:
    return b"\x0B"


def export_entry(text: str, kind: int, index: int) -> bytes:
    return name(text) + bytes([kind]) + u32(index)


def build_render_body() -> bytes:
    # Params:
    # 0 width, 1 height, 2 max_iter, 3 center_x, 4 center_y, 5 scale
    # Locals:
    # 6 y, 7 x, 8 idx, 9 iter, 10 half_w, 11 half_h, 12 cx, 13 cy,
    # 14 zr, 15 zi, 16 zr2, 17 zi2, 18 tmp
    code = bytearray()
    code += vec([u32(4) + bytes([I32]), u32(9) + bytes([F64])])

    code += local_get(0) + b"\xB7" + f64_const(0.5) + b"\xA2" + local_set(10)
    code += local_get(1) + b"\xB7" + f64_const(0.5) + b"\xA2" + local_set(11)
    code += i32_const(0) + local_set(6)

    code += block()
    code += loop()
    code += local_get(6) + local_get(1) + b"\x4E" + br_if(1)

    code += local_get(4)
    code += local_get(6) + b"\xB7"
    code += local_get(11) + b"\xA1"
    code += local_get(5) + b"\xA2"
    code += b"\xA0"
    code += local_set(13)

    code += i32_const(0) + local_set(7)
    code += block()
    code += loop()
    code += local_get(7) + local_get(0) + b"\x4E" + br_if(1)

    code += local_get(3)
    code += local_get(7) + b"\xB7"
    code += local_get(10) + b"\xA1"
    code += local_get(5) + b"\xA2"
    code += b"\xA0"
    code += local_set(12)

    code += f64_const(0.0) + local_set(14)
    code += f64_const(0.0) + local_set(15)
    code += i32_const(0) + local_set(9)

    code += block()
    code += loop()
    code += local_get(9) + local_get(2) + b"\x4E" + br_if(1)

    code += local_get(14) + local_get(14) + b"\xA2" + local_set(16)
    code += local_get(15) + local_get(15) + b"\xA2" + local_set(17)
    code += local_get(16) + local_get(17) + b"\xA0" + f64_const(4.0) + b"\x64" + br_if(1)

    code += local_get(16) + local_get(17) + b"\xA1" + local_get(12) + b"\xA0" + local_set(18)
    code += f64_const(2.0) + local_get(14) + b"\xA2" + local_get(15) + b"\xA2" + local_get(13) + b"\xA0" + local_set(15)
    code += local_get(18) + local_set(14)
    code += local_get(9) + i32_const(1) + b"\x6A" + local_set(9)
    code += br(0)
    code += end()
    code += end()

    code += local_get(6) + local_get(0) + b"\x6C" + local_get(7) + b"\x6A" + i32_const(2) + b"\x74" + local_set(8)
    code += local_get(8) + local_get(9) + b"\x36\x02\x00"
    code += local_get(7) + i32_const(1) + b"\x6A" + local_set(7)
    code += br(0)
    code += end()
    code += end()

    code += local_get(6) + i32_const(1) + b"\x6A" + local_set(6)
    code += br(0)
    code += end()
    code += end()

    code += i32_const(0)
    code += end()
    return u32(len(code)) + bytes(code)


def build_module() -> bytes:
    magic = b"\x00asm"
    version = b"\x01\x00\x00\x00"

    type_section = section(
        1,
        vec([
            bytes([FUNC_TYPE]) + vec([bytes([I32]), bytes([I32]), bytes([I32]), bytes([F64]), bytes([F64]), bytes([F64])]) + vec([bytes([I32])]),
        ]),
    )

    function_section = section(3, vec([u32(0)]))
    memory_section = section(5, vec([b"\x00" + u32(256)]))
    export_section = section(7, vec([
        export_entry("memory", 0x02, 0),
        export_entry("render", 0x00, 0),
    ]))
    code_section = section(10, vec([build_render_body()]))
    return magic + version + type_section + function_section + memory_section + export_section + code_section


def main() -> None:
    target = Path(__file__).with_name("mandelbrot.wasm")
    target.write_bytes(build_module())
    print(f"Wrote {target}")


if __name__ == "__main__":
    main()
