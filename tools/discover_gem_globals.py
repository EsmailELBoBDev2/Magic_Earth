#!/usr/bin/env python3
"""Discover libGEM globals used by set_dart_port from AArch64 code.

This replaces target-version absolute offsets with instruction-derived offsets.
It fails closed if the exported function shape is no longer recognizable.
"""
from __future__ import annotations
import argparse, json, re, struct, subprocess
from pathlib import Path

PT_LOAD=1

def signext(v,bits):
    sign=1<<(bits-1)
    return (v ^ sign) - sign

def adrp_target(insn, pc):
    if (insn & 0x9F000000) != 0x90000000: return None
    immlo=(insn>>29)&3; immhi=(insn>>5)&0x7ffff
    imm=signext((immhi<<2)|immlo,21)<<12
    return (pc & ~0xfff) + imm

def reg_rd(insn): return insn & 31

def ldst_u64(insn):
    op=insn & 0xFFC00000
    if op not in (0xF9000000,0xF9400000): return None
    rn=(insn>>5)&31; rt=insn&31; off=((insn>>10)&0xfff)*8
    return ('str' if op==0xF9000000 else 'ldr',rt,rn,off)

def elf_segments(data):
    if data[:4]!=b'\x7fELF' or data[4]!=2 or data[5]!=1: raise SystemExit('ERROR: expected ELF64 little-endian')
    e_phoff=struct.unpack_from('<Q',data,32)[0]; e_phentsize=struct.unpack_from('<H',data,54)[0]; e_phnum=struct.unpack_from('<H',data,56)[0]
    out=[]
    for i in range(e_phnum):
        o=e_phoff+i*e_phentsize
        p_type,p_flags=struct.unpack_from('<II',data,o); p_offset,p_vaddr,p_paddr,p_filesz,p_memsz,p_align=struct.unpack_from('<QQQQQQ',data,o+8)
        if p_type==PT_LOAD: out.append((p_vaddr,p_vaddr+p_filesz,p_offset))
    return out

def vaddr_to_off(v, segs):
    for lo,hi,off in segs:
        if lo<=v<hi: return off+(v-lo)
    raise SystemExit(f'ERROR: vaddr {v:#x} not in PT_LOAD')

def symbol_addr(path,name):
    out=subprocess.run(['readelf','-Ws',str(path)],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,check=False).stdout
    for line in out.splitlines():
        if re.search(rf'\b{name}$',line):
            parts=line.split()
            try: return int(parts[1],16), int(parts[2])
            except Exception: pass
    raise SystemExit(f'ERROR: export {name} not found')

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('libgem',type=Path); ap.add_argument('--json',dest='json_path',type=Path)
    a=ap.parse_args(); data=a.libgem.read_bytes(); segs=elf_segments(data)
    addr,size=symbol_addr(a.libgem,'set_dart_port'); size=max(size,128)
    off=vaddr_to_off(addr,segs); code=data[off:off+min(size,192)]
    ins=[struct.unpack_from('<I',code,i)[0] for i in range(0,len(code)-3,4)]
    adrp={}
    dart=None; post=None
    for i,x in enumerate(ins):
        pc=addr+i*4
        t=adrp_target(x,pc)
        if t is not None: adrp[reg_rd(x)]=(t,i)
        ld=ldst_u64(x)
        if not ld: continue
        kind,rt,rn,imm=ld
        base=adrp.get(rn)
        if not base or i-base[1]>6: continue
        target=base[0]+imm
        # set_dart_port's port store is STR x0,[global]
        if kind=='str' and rt==0: dart=target
        # PostCObject slot: LDR r,[global]; shortly LDR r,[r]; BLR r
        if kind=='ldr' and rt==rn:
            for j in range(i+1,min(i+5,len(ins))):
                ld2=ldst_u64(ins[j])
                if ld2 and ld2[0]=='ldr' and ld2[1]==rt and ld2[2]==rt and ld2[3]==0:
                    for k in range(j+1,min(j+4,len(ins))):
                        if (ins[k] & 0xFFFFFC1F)==0xD63F0000 and ((ins[k]>>5)&31)==rt:
                            post=target
                            break
    if dart is None or post is None:
        raise SystemExit(f'ERROR: could not derive set_dart_port globals dart={dart} post={post}')
    res={'set_dart_port':addr,'dart_port_offset':dart,'post_cobject_slot_offset':post,'dart_port_hex':hex(dart),'post_cobject_slot_hex':hex(post)}
    if a.json_path: a.json_path.write_text(json.dumps(res,indent=2)+'\n')
    print(json.dumps(res))
if __name__=='__main__': main()
