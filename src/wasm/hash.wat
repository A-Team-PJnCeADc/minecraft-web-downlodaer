;; CRC-32/IEEE(反射多项式 0xEDB88320) 与 SHA-1 压缩函数
;; 内存布局: 1024..2047 CRC 表(256 项), 2048..2367 SHA-1 消息扩展 w[80], 4096..4115 SHA-1 状态
;; JS 侧输入缓冲从 8192 开始
(module
  (memory (export "memory") 2)

  ;; 生成 CRC 表, 写入 1024 起始的 256 个 u32
  (func (export "crc32_init")
    (local $i i32) (local $j i32) (local $c i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $outer
        (br_if $done (i32.ge_u (local.get $i) (i32.const 256)))
        (local.set $c (local.get $i))
        (local.set $j (i32.const 0))
        (block $inner_done
          (loop $inner
            (br_if $inner_done (i32.ge_u (local.get $j) (i32.const 8)))
            (if (i32.and (local.get $c) (i32.const 1))
              (then (local.set $c (i32.xor (i32.shr_u (local.get $c) (i32.const 1)) (i32.const 0xEDB88320))))
              (else (local.set $c (i32.shr_u (local.get $c) (i32.const 1))))
            )
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $inner)
          )
        )
        (i32.store offset=1024 (i32.shl (local.get $i) (i32.const 2)) (local.get $c))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $outer)
      )
    )
  )

  ;; crc32_update(已完成 crc 值, 数据指针, 长度) -> 新的已完成 crc 值
  (func (export "crc32_update") (param $crc i32) (param $ptr i32) (param $len i32) (result i32)
    (local $i i32) (local $c i32) (local $b i32)
    (local.set $c (i32.xor (local.get $crc) (i32.const -1)))
    (local.set $i (i32.const 0))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $b (i32.load8_u (i32.add (local.get $ptr) (local.get $i))))
        (local.set $c (i32.xor
          (i32.shr_u (local.get $c) (i32.const 8))
          (i32.load offset=1024
            (i32.shl (i32.and (i32.xor (local.get $c) (local.get $b)) (i32.const 255)) (i32.const 2)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)
      )
    )
    (i32.xor (local.get $c) (i32.const -1))
  )

  ;; crc32_combine(crc1, crc2, len2): 把 crc2 对应的数据接在 crc1 之后 (zlib 同款矩阵算法)
  ;; 临时矩阵: even 在 3072, odd 在 3200
  (func $gf2_times (param $mat i32) (param $vec i32) (result i32)
    (local $i i32) (local $sum i32) (local $v i32)
    (local.set $i (i32.const 0))
    (local.set $sum (i32.const 0))
    (local.set $v (local.get $vec))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
        (if (i32.and (local.get $v) (i32.const 1))
          (then (local.set $sum (i32.xor (local.get $sum) (i32.load (i32.add (local.get $mat) (i32.shl (local.get $i) (i32.const 2)))))))
        )
        (local.set $v (i32.shr_u (local.get $v) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)
      )
    )
    (local.get $sum)
  )

  (func $gf2_square (param $dst i32) (param $src i32)
    (local $n i32) (local $v i32)
    (local.set $n (i32.const 0))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $n) (i32.const 32)))
        (local.set $v (call $gf2_times (local.get $src) (i32.load (i32.add (local.get $src) (i32.shl (local.get $n) (i32.const 2))))))
        (i32.store (i32.add (local.get $dst) (i32.shl (local.get $n) (i32.const 2))) (local.get $v))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (br $l)
      )
    )
  )

  (func (export "crc32_combine") (param $crc1 i32) (param $crc2 i32) (param $len2 i32) (result i32)
    (local $len i32) (local $c1 i32) (local $n i32) (local $row i32)
    (if (i32.eqz (local.get $len2)) (then (return (local.get $crc1))))
    ;; odd = x^1..x^32
    (i32.store offset=3200 (i32.const 0) (i32.const 0xEDB88320))
    (local.set $row (i32.const 1))
    (local.set $n (i32.const 1))
    (block $build_done
      (loop $build
        (br_if $build_done (i32.ge_u (local.get $n) (i32.const 32)))
        (i32.store (i32.add (i32.const 3200) (i32.shl (local.get $n) (i32.const 2))) (local.get $row))
        (local.set $row (i32.shl (local.get $row) (i32.const 1)))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (br $build)
      )
    )
    (call $gf2_square (i32.const 3072) (i32.const 3200))
    (call $gf2_square (i32.const 3200) (i32.const 3072))
    (local.set $len (local.get $len2))
    (local.set $c1 (local.get $crc1))
    (block $outer_done
      (loop $outer
        (call $gf2_square (i32.const 3072) (i32.const 3200))
        (if (i32.and (local.get $len) (i32.const 1))
          (then (local.set $c1 (call $gf2_times (i32.const 3072) (local.get $c1))))
        )
        (local.set $len (i32.shr_u (local.get $len) (i32.const 1)))
        (br_if $outer_done (i32.eqz (local.get $len)))
        (call $gf2_square (i32.const 3200) (i32.const 3072))
        (if (i32.and (local.get $len) (i32.const 1))
          (then (local.set $c1 (call $gf2_times (i32.const 3200) (local.get $c1))))
        )
        (local.set $len (i32.shr_u (local.get $len) (i32.const 1)))
        (br_if $outer_done (i32.eqz (local.get $len)))
        (br $outer)
      )
    )
    (i32.xor (local.get $c1) (local.get $crc2))
  )

  ;; sha1_blocks(statePtr, dataPtr, blockCount): dataPtr 指向 blockCount 个整 64 字节块
  (func (export "sha1_blocks") (param $st i32) (param $p i32) (param $n i32)
    (local $blk i32) (local $i i32) (local $x i32)
    (local $a i32) (local $b i32) (local $c i32) (local $d i32) (local $e i32)
    (local $f i32) (local $k i32) (local $t i32) (local $w i32)
    (local.set $blk (i32.const 0))
    (block $blocks_done
      (loop $blocks
        (br_if $blocks_done (i32.ge_u (local.get $blk) (local.get $n)))

        ;; 读入 16 个大端字
        (local.set $i (i32.const 0))
        (block $rd_done
          (loop $rd
            (br_if $rd_done (i32.ge_u (local.get $i) (i32.const 16)))
            (i32.store offset=2048
              (i32.shl (local.get $i) (i32.const 2))
              (i32.or
                (i32.or
                  (i32.shl (i32.load8_u offset=0 (i32.add (local.get $p) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 24))
                  (i32.shl (i32.load8_u offset=1 (i32.add (local.get $p) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 16)))
                (i32.or
                  (i32.shl (i32.load8_u offset=2 (i32.add (local.get $p) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 8))
                  (i32.load8_u offset=3 (i32.add (local.get $p) (i32.shl (local.get $i) (i32.const 2)))))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $rd)
          )
        )

        ;; 扩展到 80 字
        (local.set $i (i32.const 16))
        (block $ex_done
          (loop $ex
            (br_if $ex_done (i32.ge_u (local.get $i) (i32.const 80)))
            (local.set $x (i32.xor
              (i32.xor
                (i32.load offset=2048 (i32.shl (i32.sub (local.get $i) (i32.const 3)) (i32.const 2)))
                (i32.load offset=2048 (i32.shl (i32.sub (local.get $i) (i32.const 8)) (i32.const 2))))
              (i32.xor
                (i32.load offset=2048 (i32.shl (i32.sub (local.get $i) (i32.const 14)) (i32.const 2)))
                (i32.load offset=2048 (i32.shl (i32.sub (local.get $i) (i32.const 16)) (i32.const 2))))))
            (i32.store offset=2048
              (i32.shl (local.get $i) (i32.const 2))
              (i32.or (i32.shl (local.get $x) (i32.const 1)) (i32.shr_u (local.get $x) (i32.const 31))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $ex)
          )
        )

        (local.set $a (i32.load offset=0 (local.get $st)))
        (local.set $b (i32.load offset=4 (local.get $st)))
        (local.set $c (i32.load offset=8 (local.get $st)))
        (local.set $d (i32.load offset=12 (local.get $st)))
        (local.set $e (i32.load offset=16 (local.get $st)))

        (local.set $i (i32.const 0))
        (block $r_done
          (loop $r
            (br_if $r_done (i32.ge_u (local.get $i) (i32.const 80)))
            (local.set $w (i32.load offset=2048 (i32.shl (local.get $i) (i32.const 2))))
            (if (i32.lt_u (local.get $i) (i32.const 20))
              (then
                (local.set $f (i32.or (i32.and (local.get $b) (local.get $c)) (i32.and (i32.xor (local.get $b) (i32.const -1)) (local.get $d))))
                (local.set $k (i32.const 0x5A827999))
              )
              (else
                (if (i32.lt_u (local.get $i) (i32.const 40))
                  (then
                    (local.set $f (i32.xor (i32.xor (local.get $b) (local.get $c)) (local.get $d)))
                    (local.set $k (i32.const 0x6ED9EBA1))
                  )
                  (else
                    (if (i32.lt_u (local.get $i) (i32.const 60))
                      (then
                        (local.set $f (i32.or (i32.or (i32.and (local.get $b) (local.get $c)) (i32.and (local.get $b) (local.get $d))) (i32.and (local.get $c) (local.get $d))))
                        (local.set $k (i32.const 0x8F1BBCDC))
                      )
                      (else
                        (local.set $f (i32.xor (i32.xor (local.get $b) (local.get $c)) (local.get $d)))
                        (local.set $k (i32.const 0xCA62C1D6))
                      )
                    )
                  )
                )
              )
            )
            (local.set $t (i32.add
              (i32.add
                (i32.add (i32.or (i32.shl (local.get $a) (i32.const 5)) (i32.shr_u (local.get $a) (i32.const 27))) (local.get $f))
                (i32.add (local.get $e) (local.get $k)))
              (local.get $w)))
            (local.set $e (local.get $d))
            (local.set $d (local.get $c))
            (local.set $c (i32.or (i32.shl (local.get $b) (i32.const 30)) (i32.shr_u (local.get $b) (i32.const 2))))
            (local.set $b (local.get $a))
            (local.set $a (local.get $t))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $r)
          )
        )

        (i32.store offset=0 (local.get $st) (i32.add (i32.load offset=0 (local.get $st)) (local.get $a)))
        (i32.store offset=4 (local.get $st) (i32.add (i32.load offset=4 (local.get $st)) (local.get $b)))
        (i32.store offset=8 (local.get $st) (i32.add (i32.load offset=8 (local.get $st)) (local.get $c)))
        (i32.store offset=12 (local.get $st) (i32.add (i32.load offset=12 (local.get $st)) (local.get $d)))
        (i32.store offset=16 (local.get $st) (i32.add (i32.load offset=16 (local.get $st)) (local.get $e)))

        (local.set $p (i32.add (local.get $p) (i32.const 64)))
        (local.set $blk (i32.add (local.get $blk) (i32.const 1)))
        (br $blocks)
      )
    )
  )
)
