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


def if_block() -> bytes:
    return b"\x04\x40"


def build_render_body() -> bytes:
    # Params:
    # 0 width, 1 height, 2 max_iter, 3 center_x, 4 center_y, 5 scale,
    # 6 start_x, 7 start_y, 8 region_width, 9 region_height
    # Locals:
    # 10 y, 11 x, 12 out_idx, 13 iter, 14 half_w, 15 half_h, 16 cx, 17 cy,
    # 18 zr, 19 zi, 20 zr2, 21 zi2, 22 tmp
    code = bytearray()
    code += vec([u32(4) + bytes([I32]), u32(9) + bytes([F64])])

    code += local_get(0) + b"\xB7" + f64_const(0.5) + b"\xA2" + local_set(14)
    code += local_get(1) + b"\xB7" + f64_const(0.5) + b"\xA2" + local_set(15)
    code += local_get(7) + local_set(10)

    code += block()
    code += loop()
    code += local_get(10) + local_get(7) + local_get(9) + b"\x6A" + b"\x4E" + br_if(1)

    code += local_get(4)
    code += local_get(10) + b"\xB7"
    code += local_get(15) + b"\xA1"
    code += local_get(5) + b"\xA2"
    code += b"\xA0"
    code += local_set(17)

    code += local_get(6) + local_set(11)
    code += block()
    code += loop()
    code += local_get(11) + local_get(6) + local_get(8) + b"\x6A" + b"\x4E" + br_if(1)

    code += local_get(3)
    code += local_get(11) + b"\xB7"
    code += local_get(14) + b"\xA1"
    code += local_get(5) + b"\xA2"
    code += b"\xA0"
    code += local_set(16)

    code += f64_const(0.0) + local_set(18)
    code += f64_const(0.0) + local_set(19)
    code += i32_const(0) + local_set(13)

    code += block()
    code += loop()
    code += local_get(13) + local_get(2) + b"\x4E" + br_if(1)

    code += local_get(18) + local_get(18) + b"\xA2" + local_set(20)
    code += local_get(19) + local_get(19) + b"\xA2" + local_set(21)
    code += local_get(20) + local_get(21) + b"\xA0" + f64_const(4.0) + b"\x64" + br_if(1)

    code += local_get(20) + local_get(21) + b"\xA1" + local_get(16) + b"\xA0" + local_set(22)
    code += f64_const(2.0) + local_get(18) + b"\xA2" + local_get(19) + b"\xA2" + local_get(17) + b"\xA0" + local_set(19)
    code += local_get(22) + local_set(18)
    code += local_get(13) + i32_const(1) + b"\x6A" + local_set(13)
    code += br(0)
    code += end()
    code += end()

    code += local_get(10) + local_get(7) + b"\x6B" + local_get(8) + b"\x6C"
    code += local_get(11) + local_get(6) + b"\x6B" + b"\x6A"
    code += i32_const(2) + b"\x74" + local_set(12)
    code += local_get(12) + local_get(13) + b"\x36\x02\x00"
    code += local_get(11) + i32_const(1) + b"\x6A" + local_set(11)
    code += br(0)
    code += end()
    code += end()

    code += local_get(10) + i32_const(1) + b"\x6A" + local_set(10)
    code += br(0)
    code += end()
    code += end()

    code += i32_const(0)
    code += end()
    return u32(len(code)) + bytes(code)


def build_render_stride_body() -> bytes:
    # Params:
    # 0 width, 1 height, 2 max_iter, 3 center_x, 4 center_y, 5 scale, 6 stride, 7 skip_filled
    # Locals:
    # 8 y, 9 x, 10 idx, 11 iter, 12 half_w, 13 half_h, 14 cx, 15 cy,
    # 16 zr, 17 zi, 18 zr2, 19 zi2, 20 tmp
    code = bytearray()
    code += vec([u32(4) + bytes([I32]), u32(9) + bytes([F64])])

    code += local_get(0) + b"\xB7" + f64_const(0.5) + b"\xA2" + local_set(12)
    code += local_get(1) + b"\xB7" + f64_const(0.5) + b"\xA2" + local_set(13)
    code += i32_const(0) + local_set(8)

    code += block()
    code += loop()
    code += local_get(8) + local_get(1) + b"\x4E" + br_if(1)

    code += local_get(4)
    code += local_get(8) + b"\xB7"
    code += local_get(13) + b"\xA1"
    code += local_get(5) + b"\xA2"
    code += b"\xA0"
    code += local_set(15)

    code += i32_const(0) + local_set(9)
    code += block()
    code += loop()
    code += local_get(9) + local_get(0) + b"\x4E" + br_if(1)

    code += local_get(8) + local_get(0) + b"\x6C" + local_get(9) + b"\x6A" + i32_const(2) + b"\x74" + local_set(10)

    code += block()
    code += local_get(7) + i32_const(0) + b"\x47"
    code += if_block()
    code += local_get(10) + b"\x28\x02\x00" + i32_const(-1) + b"\x47" + br_if(1)
    code += end()

    code += local_get(3)
    code += local_get(9) + b"\xB7"
    code += local_get(12) + b"\xA1"
    code += local_get(5) + b"\xA2"
    code += b"\xA0"
    code += local_set(14)

    code += f64_const(0.0) + local_set(16)
    code += f64_const(0.0) + local_set(17)
    code += i32_const(0) + local_set(11)

    code += block()
    code += loop()
    code += local_get(11) + local_get(2) + b"\x4E" + br_if(1)

    code += local_get(16) + local_get(16) + b"\xA2" + local_set(18)
    code += local_get(17) + local_get(17) + b"\xA2" + local_set(19)
    code += local_get(18) + local_get(19) + b"\xA0" + f64_const(4.0) + b"\x64" + br_if(1)

    code += local_get(18) + local_get(19) + b"\xA1" + local_get(14) + b"\xA0" + local_set(20)
    code += f64_const(2.0) + local_get(16) + b"\xA2" + local_get(17) + b"\xA2" + local_get(15) + b"\xA0" + local_set(17)
    code += local_get(20) + local_set(16)
    code += local_get(11) + i32_const(1) + b"\x6A" + local_set(11)
    code += br(0)
    code += end()
    code += end()

    code += local_get(10) + local_get(11) + b"\x36\x02\x00"
    code += end()

    code += local_get(9) + local_get(6) + b"\x6A" + local_set(9)
    code += br(0)
    code += end()
    code += end()

    code += local_get(8) + local_get(6) + b"\x6A" + local_set(8)
    code += br(0)
    code += end()
    code += end()

    code += i32_const(0)
    code += end()
    return u32(len(code)) + bytes(code)


def build_render_julia_body() -> bytes:
    # Params:
    # 0 width, 1 height, 2 max_iter, 3 center_x, 4 center_y, 5 scale, 6 c_re, 7 c_im,
    # 8 start_x, 9 start_y, 10 region_width, 11 region_height
    # Locals:
    # 12 y, 13 x, 14 out_idx, 15 iter, 16 half_w, 17 half_h, 18 zr, 19 zi, 20 zr2, 21 zi2, 22 tmp
    code = bytearray()
    code += vec([u32(4) + bytes([I32]), u32(7) + bytes([F64])])

    code += local_get(0) + b"\xB7" + f64_const(0.5) + b"\xA2" + local_set(16)
    code += local_get(1) + b"\xB7" + f64_const(0.5) + b"\xA2" + local_set(17)
    code += local_get(9) + local_set(12)

    code += block()
    code += loop()
    code += local_get(12) + local_get(9) + local_get(11) + b"\x6A" + b"\x4E" + br_if(1)

    code += local_get(8) + local_set(13)
    code += block()
    code += loop()
    code += local_get(13) + local_get(8) + local_get(10) + b"\x6A" + b"\x4E" + br_if(1)

    code += local_get(3)
    code += local_get(13) + b"\xB7"
    code += local_get(16) + b"\xA1"
    code += local_get(5) + b"\xA2"
    code += b"\xA0"
    code += local_set(18)

    code += local_get(4)
    code += local_get(12) + b"\xB7"
    code += local_get(17) + b"\xA1"
    code += local_get(5) + b"\xA2"
    code += b"\xA0"
    code += local_set(19)

    code += i32_const(0) + local_set(15)

    code += block()
    code += loop()
    code += local_get(15) + local_get(2) + b"\x4E" + br_if(1)

    code += local_get(18) + local_get(18) + b"\xA2" + local_set(20)
    code += local_get(19) + local_get(19) + b"\xA2" + local_set(21)
    code += local_get(20) + local_get(21) + b"\xA0" + f64_const(4.0) + b"\x64" + br_if(1)

    code += local_get(20) + local_get(21) + b"\xA1" + local_get(6) + b"\xA0" + local_set(22)
    code += f64_const(2.0) + local_get(18) + b"\xA2" + local_get(19) + b"\xA2" + local_get(7) + b"\xA0" + local_set(19)
    code += local_get(22) + local_set(18)
    code += local_get(15) + i32_const(1) + b"\x6A" + local_set(15)
    code += br(0)
    code += end()
    code += end()

    code += local_get(12) + local_get(9) + b"\x6B" + local_get(10) + b"\x6C"
    code += local_get(13) + local_get(8) + b"\x6B" + b"\x6A"
    code += i32_const(2) + b"\x74" + local_set(14)
    code += local_get(14) + local_get(15) + b"\x36\x02\x00"

    code += local_get(13) + i32_const(1) + b"\x6A" + local_set(13)
    code += br(0)
    code += end()
    code += end()

    code += local_get(12) + i32_const(1) + b"\x6A" + local_set(12)
    code += br(0)
    code += end()
    code += end()

    code += i32_const(0)
    code += end()
    return u32(len(code)) + bytes(code)


def build_render_julia_stride_body() -> bytes:
    # Params:
    # 0 width, 1 height, 2 max_iter, 3 center_x, 4 center_y, 5 scale, 6 c_re, 7 c_im, 8 stride, 9 skip_filled
    # Locals:
    # 10 y, 11 x, 12 idx, 13 iter, 14 half_w, 15 half_h, 16 zr, 17 zi, 18 zr2, 19 zi2, 20 tmp
    code = bytearray()
    code += vec([u32(4) + bytes([I32]), u32(7) + bytes([F64])])

    code += local_get(0) + b"\xB7" + f64_const(0.5) + b"\xA2" + local_set(14)
    code += local_get(1) + b"\xB7" + f64_const(0.5) + b"\xA2" + local_set(15)
    code += i32_const(0) + local_set(10)

    code += block()
    code += loop()
    code += local_get(10) + local_get(1) + b"\x4E" + br_if(1)

    code += i32_const(0) + local_set(11)
    code += block()
    code += loop()
    code += local_get(11) + local_get(0) + b"\x4E" + br_if(1)

    code += local_get(10) + local_get(0) + b"\x6C" + local_get(11) + b"\x6A" + i32_const(2) + b"\x74" + local_set(12)

    code += block()
    code += local_get(9) + i32_const(0) + b"\x47"
    code += if_block()
    code += local_get(12) + b"\x28\x02\x00" + i32_const(-1) + b"\x47" + br_if(1)
    code += end()

    code += local_get(3)
    code += local_get(11) + b"\xB7"
    code += local_get(14) + b"\xA1"
    code += local_get(5) + b"\xA2"
    code += b"\xA0"
    code += local_set(16)

    code += local_get(4)
    code += local_get(10) + b"\xB7"
    code += local_get(15) + b"\xA1"
    code += local_get(5) + b"\xA2"
    code += b"\xA0"
    code += local_set(17)

    code += i32_const(0) + local_set(13)

    code += block()
    code += loop()
    code += local_get(13) + local_get(2) + b"\x4E" + br_if(1)

    code += local_get(16) + local_get(16) + b"\xA2" + local_set(18)
    code += local_get(17) + local_get(17) + b"\xA2" + local_set(19)
    code += local_get(18) + local_get(19) + b"\xA0" + f64_const(4.0) + b"\x64" + br_if(1)

    code += local_get(18) + local_get(19) + b"\xA1" + local_get(6) + b"\xA0" + local_set(20)
    code += f64_const(2.0) + local_get(16) + b"\xA2" + local_get(17) + b"\xA2" + local_get(7) + b"\xA0" + local_set(17)
    code += local_get(20) + local_set(16)
    code += local_get(13) + i32_const(1) + b"\x6A" + local_set(13)
    code += br(0)
    code += end()
    code += end()

    code += local_get(12) + local_get(13) + b"\x36\x02\x00"
    code += end()

    code += local_get(11) + local_get(8) + b"\x6A" + local_set(11)
    code += br(0)
    code += end()
    code += end()

    code += local_get(10) + local_get(8) + b"\x6A" + local_set(10)
    code += br(0)
    code += end()
    code += end()

    code += i32_const(0)
    code += end()
    return u32(len(code)) + bytes(code)


def build_guess_body() -> bytes:
    # Params: 0 width, 1 height, 2 stride
    # Locals:
    # 3 y, 4 x, 5 val, 6 gyi, 7 gxi, 8 px, 9 py, 10 idx, 11 step, 12 fy, 13 fx, 14 ok
    code = bytearray()
    code += vec([u32(12) + bytes([I32])])

    code += local_get(2) + i32_const(1) + b"\x76" + local_set(11)
    code += local_get(2) + local_set(3)

    code += block()
    code += loop()
    code += local_get(3) + local_get(2) + local_get(2) + b"\x6A" + b"\x6A" + local_get(1) + b"\x4E" + br_if(1)

    code += local_get(2) + local_set(4)
    code += block()
    code += loop()
    code += local_get(4) + local_get(2) + local_get(2) + b"\x6A" + b"\x6A" + local_get(0) + b"\x4E" + br_if(1)

    code += local_get(3) + local_get(2) + b"\x6B" + local_set(9)
    code += local_get(4) + local_get(2) + b"\x6B" + local_set(8)
    code += local_get(9) + local_get(0) + b"\x6C" + local_get(8) + b"\x6A" + i32_const(2) + b"\x74" + local_set(10)
    code += local_get(10) + b"\x28\x02\x00" + local_set(5)

    code += block()
    code += local_get(5) + i32_const(-1) + b"\x46" + br_if(0)
    code += i32_const(1) + local_set(14)
    code += i32_const(0) + local_set(6)

    code += block()
    code += loop()
    code += local_get(6) + i32_const(4) + b"\x4E" + br_if(1)

    code += i32_const(0) + local_set(7)
    code += block()
    code += loop()
    code += local_get(7) + i32_const(4) + b"\x4E" + br_if(1)

    code += local_get(4) + local_get(2) + b"\x6B" + local_get(7) + local_get(2) + b"\x6C" + b"\x6A" + local_set(8)
    code += local_get(3) + local_get(2) + b"\x6B" + local_get(6) + local_get(2) + b"\x6C" + b"\x6A" + local_set(9)
    code += local_get(9) + local_get(0) + b"\x6C" + local_get(8) + b"\x6A" + i32_const(2) + b"\x74" + local_set(10)
    code += block()
    code += local_get(10) + b"\x28\x02\x00" + local_get(5) + b"\x47" + br_if(0)
    code += end()

    code += local_get(7) + i32_const(1) + b"\x6A" + local_set(7)
    code += br(0)
    code += end()
    code += end()

    code += local_get(6) + i32_const(1) + b"\x6A" + local_set(6)
    code += br(0)
    code += end()
    code += end()

    code += local_get(14) + i32_const(0) + b"\x46" + br_if(0)

    code += i32_const(0) + local_set(12)
    code += block()
    code += loop()
    code += local_get(12) + local_get(2) + b"\x4F" + br_if(1)

    code += i32_const(0) + local_set(13)
    code += block()
    code += loop()
    code += local_get(13) + local_get(2) + b"\x4F" + br_if(1)

    code += block()
    code += local_get(12) + i32_const(0) + b"\x46"
    code += local_get(12) + local_get(2) + b"\x46" + b"\x72"
    code += local_get(13) + i32_const(0) + b"\x46"
    code += local_get(13) + local_get(2) + b"\x46" + b"\x72"
    code += b"\x71" + br_if(0)

    code += local_get(4) + local_get(13) + b"\x6A" + local_set(8)
    code += local_get(3) + local_get(12) + b"\x6A" + local_set(9)
    code += local_get(9) + local_get(0) + b"\x6C" + local_get(8) + b"\x6A" + i32_const(2) + b"\x74" + local_set(10)
    code += block()
    code += local_get(10) + b"\x28\x02\x00" + i32_const(-1) + b"\x47" + br_if(0)
    code += local_get(10) + local_get(5) + b"\x36\x02\x00"
    code += end()

    code += end()

    code += local_get(13) + local_get(11) + b"\x6A" + local_set(13)
    code += br(0)
    code += end()
    code += end()

    code += local_get(12) + local_get(11) + b"\x6A" + local_set(12)
    code += br(0)
    code += end()
    code += end()

    code += end()

    code += local_get(4) + local_get(2) + b"\x6A" + local_set(4)
    code += br(0)
    code += end()
    code += end()

    code += local_get(3) + local_get(2) + b"\x6A" + local_set(3)
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
            bytes([FUNC_TYPE]) + vec([bytes([I32]), bytes([I32]), bytes([I32]), bytes([F64]), bytes([F64]), bytes([F64]), bytes([I32]), bytes([I32]), bytes([I32]), bytes([I32])]) + vec([bytes([I32])]),
            bytes([FUNC_TYPE]) + vec([bytes([I32]), bytes([I32]), bytes([I32]), bytes([F64]), bytes([F64]), bytes([F64]), bytes([I32]), bytes([I32])]) + vec([bytes([I32])]),
            bytes([FUNC_TYPE]) + vec([bytes([I32]), bytes([I32]), bytes([I32])]) + vec([bytes([I32])]),
            bytes([FUNC_TYPE]) + vec([bytes([I32]), bytes([I32]), bytes([I32]), bytes([F64]), bytes([F64]), bytes([F64]), bytes([F64]), bytes([F64]), bytes([I32]), bytes([I32]), bytes([I32]), bytes([I32])]) + vec([bytes([I32])]),
            bytes([FUNC_TYPE]) + vec([bytes([I32]), bytes([I32]), bytes([I32]), bytes([F64]), bytes([F64]), bytes([F64]), bytes([F64]), bytes([F64]), bytes([I32]), bytes([I32])]) + vec([bytes([I32])]),
        ]),
    )

    function_section = section(3, vec([u32(0), u32(1), u32(2), u32(3), u32(4)]))
    memory_section = section(5, vec([b"\x00" + u32(256)]))
    export_section = section(7, vec([
        export_entry("memory", 0x02, 0),
        export_entry("render", 0x00, 0),
        export_entry("render_stride", 0x00, 1),
        export_entry("guess", 0x00, 2),
        export_entry("render_julia", 0x00, 3),
        export_entry("render_julia_stride", 0x00, 4),
    ]))
    code_section = section(10, vec([build_render_body(), build_render_stride_body(), build_guess_body(), build_render_julia_body(), build_render_julia_stride_body()]))
    return magic + version + type_section + function_section + memory_section + export_section + code_section


def main() -> None:
    target = Path(__file__).with_name("mandelbrot.wasm")
    target.write_bytes(build_module())
    print(f"Wrote {target}")


if __name__ == "__main__":
    main()
