/**
 * renderer.js
 * ------------------------------------------------------------
 * WebGL2 インスタンシング・スプライトスタッキング描画エンジン！
 *
 * 【構成】
 * - 地形の全スライス (768x768 x 最大97層) を 1枚の TEXTURE_2D_ARRAY に格納
 * - 8段階の水データ (128x128 x 12層 x RG8 = 393KB) を 1枚の TEXTURE_2D_ARRAY に転送
 *   → 水が流れても変更層だけ texSubImage3D (0.1ms未満) で更新するため、水流中でも60fps！
 * - フラグメントシェーダーで 60fps 連続 Worley/Voronoi 水面コースティクス＋岸辺の白波を計算
 * - プレイヤーより下の層を1コール、上の層を1コール、プレイヤー帯(12層)のみ層ごとにインターリーブし、
 *   128x128x12 ワールド全体＋水＋プレイヤーをわずか ~28 ドローコールで描画します。
 */
(function (global) {
  "use strict";

  const { BLOCK_SIZE, BLOCK_SLICES, PLAYER_POSES } = global.VoxelWalk;

  // ============================================================
  // シェーダーソース（WebGL2 / GLSL ES 3.00）
  // ============================================================
  const WORLD_VS = `#version 300 es
    precision highp float;

    // 単位クワッド頂点 (0..1)
    layout(location = 0) in vec2 aQuadPos;

    uniform vec2 uViewport;       // (viewW, viewH)
    uniform vec2 uCenter;         // (centerX, centerY)
    uniform vec2 uCamXY;          // (cam.x, cam.y) in blocks
    uniform float uCamBaseSlice;  // cam.z * BLOCK_SLICES
    uniform vec2 uYawCS;          // (cos(yaw), sin(yaw))
    uniform float uSquashY;       // sin(pitch)
    uniform float uLiftPerSlice;  // px per slice
    uniform float uBlockPx;       // px per block
    uniform vec4 uCropBlocks;     // (minBx, minBy, maxBx, maxBy)
    uniform vec2 uWorldSize;      // (128, 128)
    uniform int uStartSlice;

    out vec2 vBlockPos;
    flat out int vSliceZ;

    void main() {
      int sliceZ = uStartSlice + gl_InstanceID;
      vSliceZ = sliceZ;

      // 可視クロップ矩形内だけをクワッド化（画面外のピクセルフィルを削減）
      vec2 bPos = mix(uCropBlocks.xy, uCropBlocks.zw, aQuadPos);
      vBlockPos = bPos;

      vec2 rel = (bPos - uCamXY) * uBlockPx;
      float rx = rel.x * uYawCS.x - rel.y * uYawCS.y;
      float ry = (rel.x * uYawCS.y + rel.y * uYawCS.x) * uSquashY;

      float sliceOffsetY = -(float(sliceZ) - uCamBaseSlice) * uLiftPerSlice;
      vec2 screenPx = vec2(uCenter.x + rx, uCenter.y + sliceOffsetY + ry);

      vec2 ndc = (screenPx / uViewport) * 2.0 - 1.0;
      ndc.y = -ndc.y;
      gl_Position = vec4(ndc, 0.0, 1.0);
    }
  `;

  const WORLD_FS = `#version 300 es
    precision highp float;
    precision highp sampler2DArray;

    uniform sampler2DArray uTerrainTex; // 768x768 x N slices (RGBA8)
    uniform sampler2DArray uWaterTex;   // 128x128 x 14 layers (RG8: R=visLevel 0..8, G=bit0:fall | bit1:solid)
    uniform vec2 uWorldSize;            // (128, 128)
    uniform int uWorldZ;                // 14
    uniform int uTerrainLayers;
    uniform float uTime;
    uniform int uMode;                  // 0=地形+水, 1=地形のみ, 2=水のみ
    uniform int uWireframe;

    // 洞窟・遮蔽時の X-Ray 透視カットアウト＆松明ライト用 uniform
    uniform vec2 uPlayerScreenPos;      // プレイヤー中心の画面座標（左下原点 = gl_FragCoord 系）
    uniform vec3 uPlayerWorldPos;       // プレイヤーの3Dワールド座標（洞窟内の松明ライト用）
    uniform int uPlayerBaseSlice;       // プレイヤー足元のスライス高さ
    uniform float uBlockPx;             // 1ブロックの画面ピクセル幅
    uniform float uOcclusionFade;       // 0.0 (非遮蔽) .. 1.0 (洞窟/崖裏で遮蔽中)
    uniform float uXrayRadiusPx;        // 透視窓の半径 (px)
    uniform int uXrayMode;              // 0=輪郭線のみ(外表面), 1=うっすら半透明(外表面1層), 2=完全切り抜き

    in vec2 vBlockPos;
    flat in int vSliceZ;

    out vec4 outColor;

    // 60fps 連続 Worley / Voronoi コースティクス（水面の網目模様）
    vec2 hash22(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.xx + p3.yz) * p3.zy);
    }

    vec2 waterCaustic(vec2 blockPos, float t) {
      // ドット絵世界になじむよう 1ブロック=4px グリッドに軽く量子化
      vec2 wp = floor(blockPos * 4.0) * 0.25;
      vec2 p = wp * 0.45;
      vec2 ip = floor(p);
      vec2 fp = fract(p);

      float d1 = 8.0;
      float d2 = 8.0;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 cell = ip + vec2(float(i), float(j));
          vec2 h = hash22(cell);
          float dir = (mod(cell.x + cell.y, 2.0) < 0.5) ? 1.0 : -1.0;
          float ang = h.x * 6.2831853 + t * 0.95 * dir;
          vec2 pt = vec2(float(i), float(j)) + 0.5 + (h - 0.5) * 0.54 + vec2(cos(ang), sin(ang)) * 0.15;
          vec2 diff = pt - fp;
          float dist = length(diff);
          if (dist < d1) {
            d2 = d1;
            d1 = dist;
          } else if (dist < d2) {
            d2 = dist;
          }
        }
      }
      float ridge = d2 - d1;
      float web = clamp(1.0 - ridge / 0.21, 0.0, 1.0);
      float cellEdge = clamp(d1 / 0.72, 0.0, 1.0);
      return vec2(web * web, cellEdge);
    }

    ivec2 sampleWaterCell(ivec2 bxy, int bz) {
      if (bz < 0 || bz >= uWorldZ || bxy.x < 0 || bxy.y < 0 || bxy.x >= int(uWorldSize.x) || bxy.y >= int(uWorldSize.y)) {
        return ivec2(0, 0);
      }
      vec2 rg = texelFetch(uWaterTex, ivec3(bxy, bz), 0).rg;
      return ivec2(int(floor(rg.r * 255.0 + 0.5)), int(floor(rg.g * 255.0 + 0.5)));
    }

    void main() {
      vec2 uv = vBlockPos / uWorldSize;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;

      // 1. 固体地形スライス評価
      if (uMode != 2 && vSliceZ < uTerrainLayers) {
        vec4 tCol = texture(uTerrainTex, vec3(uv, float(vSliceZ)));
        if (tCol.a > 0.5) {
          // スライス枠デバッグ表示（ブロック境目ごとに薄い枠線）
          if (uWireframe == 1 && (vSliceZ % 8) == 0) {
            vec2 edgeDist = min(vBlockPos, uWorldSize - vBlockPos);
            if (min(edgeDist.x, edgeDist.y) < 0.12) {
              tCol.rgb = mix(tCol.rgb, vec3(1.0), 0.35);
            }
          }

          // ★ 洞窟・崖裏の X-Ray 透視処理
          //   - プレイヤーすぐ手前の狭い範囲 (1.35 blk) は膝上から切り抜いて自機を確実に視認
          //   - 広い透視窓 (uXrayRadiusPx) は頭上 (+12スライス=1.5blk) から切り抜き、
          //     洞窟の床と周囲の壁をしっかり残しつつ天井の山だけをスッキリ透過させる！
          if (uOcclusionFade > 0.01) {
            float screenDist = length(gl_FragCoord.xy - uPlayerScreenPos);
            int cutSlice = (screenDist < uBlockPx * 1.35) ? (uPlayerBaseSlice + 4) : (uPlayerBaseSlice + 12);

            if (vSliceZ >= cutSlice && screenDist < uXrayRadiusPx) {
              float mask = (1.0 - smoothstep(uXrayRadiusPx * 0.78, uXrayRadiusPx, screenDist)) * uOcclusionFade;
              if (mask > 0.15) {
                if (uXrayMode == 2) {
                  // モード2: 完全切り抜き（洞窟内部が100%くっきり見える）
                  if (mask > 0.45) discard;
                  outColor = vec4(tCol.rgb, 1.0 - mask * 1.6);
                  return;
                }

                // 山や天井の「一番外側の露出天面（1層だけ）」かどうかを判定
                // ※ 埋没した内部の何十層ものスライスはすべて discard するため網目だらけにならない！
                bool isBlockPlane = (vSliceZ % 8) == 0;
                int curBz = vSliceZ / 8;
                ivec2 bxy = ivec2(floor(vBlockPos));
                bool isExposedRoof =
                  isBlockPlane &&
                  curBz > 0 &&
                  ((sampleWaterCell(bxy, curBz - 1).y & 2) != 0) &&
                  ((sampleWaterCell(bxy, curBz).y & 2) == 0);

                if (uXrayMode == 1) {
                  // モード1: 外表面1層だけをうっすら半透明（フォグ化せず山の形が上品に透ける）
                  if (isExposedRoof) {
                    outColor = vec4(tCol.rgb, mix(1.0, 0.16, mask));
                    return;
                  }
                  if (mask > 0.45) discard;
                  outColor = vec4(tCol.rgb, 1.0 - mask * 1.6);
                  return;
                } else {
                  // モード0 (デフォルト): 外表面の「実際の地形段差（崖・尾根の輪郭）」だけを描く
                  // 1x1 ブロックごとの細かい格子線は描かず、山の外郭シルエットだけが残る！
                  if (isExposedRoof) {
                    int roofBz = curBz - 1;
                    vec2 fxy = fract(vBlockPos);
                    bool edgeW = fxy.x < 0.16 && ((sampleWaterCell(bxy + ivec2(-1, 0), roofBz).y & 2) == 0);
                    bool edgeE = fxy.x > 0.84 && ((sampleWaterCell(bxy + ivec2(1, 0), roofBz).y & 2) == 0);
                    bool edgeN = fxy.y < 0.16 && ((sampleWaterCell(bxy + ivec2(0, -1), roofBz).y & 2) == 0);
                    bool edgeS = fxy.y > 0.84 && ((sampleWaterCell(bxy + ivec2(0, 1), roofBz).y & 2) == 0);
                    if (edgeW || edgeE || edgeN || edgeS) {
                      vec3 contourCol = mix(tCol.rgb * 1.1, vec3(0.65, 0.92, 1.0), 0.55);
                      outColor = vec4(contourCol, 0.45 * mask + (1.0 - mask));
                      return;
                    }
                    // 窓の外縁（切り抜き境界）に細い淡い縁を残して境目をわかりやすく
                    if (screenDist > uXrayRadiusPx * 0.92) {
                      outColor = vec4(tCol.rgb, (1.0 - mask) * 0.7);
                      return;
                    }
                    discard;
                  }
                  if (mask > 0.45) discard;
                  outColor = vec4(tCol.rgb, 1.0 - mask * 1.6);
                  return;
                }
              }
            }

            // ★ 洞窟内の視認性アップ：プレイヤー周囲の床・壁をほんのり暖色の松明ライトで照らす
            if (vSliceZ < uPlayerBaseSlice + 14) {
              vec3 fragWorld = vec3(vBlockPos, float(vSliceZ) / 8.0);
              float d3 = length(fragWorld - (uPlayerWorldPos + vec3(0.0, 0.0, 0.8)));
              float torch = clamp(1.0 - d3 / 6.5, 0.0, 1.0);
              torch = torch * torch * uOcclusionFade;
              tCol.rgb *= (1.0 + torch * vec3(0.58, 0.46, 0.24));
            }
          }

          outColor = vec4(tCol.rgb, 1.0);
          return;
        }
      }

      if (uMode == 1) discard;

      // 2. 水スライス評価（内部はほぼ透明、露出水面だけ控えめな Worley 網目＋岸辺の白波）
      int bz = vSliceZ / 8;
      int lz = vSliceZ - bz * 8;
      ivec2 bxy = ivec2(floor(vBlockPos));

      ivec2 curW = sampleWaterCell(bxy, bz);
      int visLevel = curW.x;
      int flags = curW.y;
      bool curSolid = (flags & 2) != 0;
      bool isFalling = (flags & 1) != 0;

      // 露出水面チェック
      bool isSurface = false;
      int surfBz = bz;
      if (lz > 0 && bz < uWorldZ && visLevel == lz) {
        isSurface = true;
      } else if (lz == 0 && bz > 0 && visLevel == 0 && !curSolid) {
        ivec2 belowW = sampleWaterCell(bxy, bz - 1);
        if (belowW.x == 8) {
          isSurface = true;
          surfBz = bz - 1;
        }
      }

      if (isSurface) {
        vec2 wc = waterCaustic(vBlockPos, uTime);
        float webSharp = wc.x;
        float cellEdge = wc.y;

        vec3 rgb = vec3(
          (22.0 + cellEdge * 20.0 + webSharp * 70.0) / 255.0,
          (130.0 + cellEdge * 26.0 + webSharp * 62.0) / 255.0,
          (198.0 + cellEdge * 18.0 + webSharp * 32.0) / 255.0
        );
        float alpha = (48.0 + cellEdge * 22.0 + webSharp * 68.0) / 255.0;

        // WebGL ならでは：岸辺（固体ブロックと接する縁 0.18ブロック幅）に穏やかなさざ波ハイライト
        vec2 fxy = fract(vBlockPos);
        float shore = 0.0;
        if (fxy.x < 0.18 && (sampleWaterCell(bxy + ivec2(-1, 0), surfBz).y & 2) != 0) shore = max(shore, 1.0 - fxy.x / 0.18);
        if (fxy.x > 0.82 && (sampleWaterCell(bxy + ivec2(1, 0), surfBz).y & 2) != 0) shore = max(shore, (fxy.x - 0.82) / 0.18);
        if (fxy.y < 0.18 && (sampleWaterCell(bxy + ivec2(0, -1), surfBz).y & 2) != 0) shore = max(shore, 1.0 - fxy.y / 0.18);
        if (fxy.y > 0.82 && (sampleWaterCell(bxy + ivec2(0, 1), surfBz).y & 2) != 0) shore = max(shore, (fxy.y - 0.82) / 0.18);

        if (shore > 0.0) {
          float pulse = 0.7 + 0.3 * sin(uTime * 2.2 + vBlockPos.x * 1.3 + vBlockPos.y * 1.1);
          float foam = shore * 0.32 * pulse;
          rgb = mix(rgb, vec3(0.74, 0.94, 1.0), foam);
          alpha = min(0.75, alpha + foam * 0.35);
        }

        outColor = vec4(rgb, alpha);
        return;
      }

      // 水の体積（中はほぼ透明な深い青、滝は泡立ったシアン）
      if (bz < uWorldZ && visLevel >= lz + 1) {
        if (isFalling) {
          float streak = 0.85 + 0.15 * sin(uTime * 9.0 + float(vSliceZ) * 0.9 + vBlockPos.x * 3.0);
          outColor = vec4(vec3(0.34, 0.78, 0.95) * streak, 0.25);
        } else {
          outColor = vec4(0.04, 0.36, 0.68, 0.078);
        }
        return;
      }

      discard;
    }
  `;

  // プレイヤー＆接地影用シェーダー
  const SPRITE_VS = `#version 300 es
    precision highp float;

    layout(location = 0) in vec2 aQuadPos; // 0..1

    uniform vec2 uViewport;
    uniform vec2 uCenter;
    uniform vec2 uCamXY;
    uniform float uCamBaseSlice;
    uniform vec2 uYawCS;
    uniform float uSquashY;
    uniform float uLiftPerSlice;
    uniform float uBlockPx;

    uniform vec2 uSpriteBlockXY;
    uniform float uSpriteSizeBlocks;
    uniform vec2 uFacingCS;
    uniform int uSliceZ;

    out vec2 vUV;

    void main() {
      vUV = aQuadPos;
      vec2 local = (aQuadPos - 0.5) * uSpriteSizeBlocks;
      vec2 worldLocal = vec2(
        local.x * uFacingCS.x - local.y * uFacingCS.y,
        local.x * uFacingCS.y + local.y * uFacingCS.x
      );
      vec2 bPos = uSpriteBlockXY + worldLocal;

      vec2 rel = (bPos - uCamXY) * uBlockPx;
      float rx = rel.x * uYawCS.x - rel.y * uYawCS.y;
      float ry = (rel.x * uYawCS.y + rel.y * uYawCS.x) * uSquashY;

      float sliceOffsetY = -(float(uSliceZ) - uCamBaseSlice) * uLiftPerSlice;
      vec2 screenPx = vec2(uCenter.x + rx, uCenter.y + sliceOffsetY + ry);

      vec2 ndc = (screenPx / uViewport) * 2.0 - 1.0;
      ndc.y = -ndc.y;
      gl_Position = vec4(ndc, 0.0, 1.0);
    }
  `;

  const SPRITE_FS = `#version 300 es
    precision highp float;
    precision highp sampler2DArray;

    uniform sampler2DArray uPlayerTex;
    uniform int uPlayerLayer;
    uniform int uIsShadow;
    uniform float uShadowAlpha;
    uniform int uShowBox;

    in vec2 vUV;
    out vec4 outColor;

    void main() {
      if (uIsShadow == 1) {
        vec2 d = (vUV - 0.5) * 2.0;
        if (dot(d, d) > 1.0) discard;
        outColor = vec4(0.04, 0.08, 0.05, uShadowAlpha);
        return;
      }

      if (uShowBox == 1) {
        vec2 e = min(vUV, 1.0 - vUV);
        if (min(e.x, e.y) < 0.04) {
          outColor = vec4(0.98, 0.75, 0.14, 0.8);
          return;
        }
      }

      vec4 col = texture(uPlayerTex, vec3(vUV, float(uPlayerLayer)));
      if (col.a < 0.5) discard;
      outColor = col;
    }
  `;

  // ============================================================
  // WebGL2 リソース管理
  // ============================================================
  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("WebGL2 shader compile error: " + log);
    }
    return sh;
  }

  function createProgram(gl, vsSrc, fsSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      throw new Error("WebGL2 link error: " + log);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  function createWebGLRenderer(canvas) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      throw new Error("WebGL2 が利用できません。対応ブラウザで開いてください。");
    }

    const worldProg = createProgram(gl, WORLD_VS, WORLD_FS);
    const spriteProg = createProgram(gl, SPRITE_VS, SPRITE_FS);

    // 単位クワッド VAO (2三角形 = 6頂点)
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Uniform ロケーションキャッシュ
    const wLoc = {
      uViewport: gl.getUniformLocation(worldProg, "uViewport"),
      uCenter: gl.getUniformLocation(worldProg, "uCenter"),
      uCamXY: gl.getUniformLocation(worldProg, "uCamXY"),
      uCamBaseSlice: gl.getUniformLocation(worldProg, "uCamBaseSlice"),
      uYawCS: gl.getUniformLocation(worldProg, "uYawCS"),
      uSquashY: gl.getUniformLocation(worldProg, "uSquashY"),
      uLiftPerSlice: gl.getUniformLocation(worldProg, "uLiftPerSlice"),
      uBlockPx: gl.getUniformLocation(worldProg, "uBlockPx"),
      uCropBlocks: gl.getUniformLocation(worldProg, "uCropBlocks"),
      uWorldSize: gl.getUniformLocation(worldProg, "uWorldSize"),
      uStartSlice: gl.getUniformLocation(worldProg, "uStartSlice"),
      uTerrainTex: gl.getUniformLocation(worldProg, "uTerrainTex"),
      uWaterTex: gl.getUniformLocation(worldProg, "uWaterTex"),
      uWorldZ: gl.getUniformLocation(worldProg, "uWorldZ"),
      uTerrainLayers: gl.getUniformLocation(worldProg, "uTerrainLayers"),
      uTime: gl.getUniformLocation(worldProg, "uTime"),
      uMode: gl.getUniformLocation(worldProg, "uMode"),
      uWireframe: gl.getUniformLocation(worldProg, "uWireframe"),
      uPlayerScreenPos: gl.getUniformLocation(worldProg, "uPlayerScreenPos"),
      uPlayerWorldPos: gl.getUniformLocation(worldProg, "uPlayerWorldPos"),
      uPlayerBaseSlice: gl.getUniformLocation(worldProg, "uPlayerBaseSlice"),
      uOcclusionFade: gl.getUniformLocation(worldProg, "uOcclusionFade"),
      uXrayRadiusPx: gl.getUniformLocation(worldProg, "uXrayRadiusPx"),
      uXrayMode: gl.getUniformLocation(worldProg, "uXrayMode"),
    };

    const sLoc = {
      uViewport: gl.getUniformLocation(spriteProg, "uViewport"),
      uCenter: gl.getUniformLocation(spriteProg, "uCenter"),
      uCamXY: gl.getUniformLocation(spriteProg, "uCamXY"),
      uCamBaseSlice: gl.getUniformLocation(spriteProg, "uCamBaseSlice"),
      uYawCS: gl.getUniformLocation(spriteProg, "uYawCS"),
      uSquashY: gl.getUniformLocation(spriteProg, "uSquashY"),
      uLiftPerSlice: gl.getUniformLocation(spriteProg, "uLiftPerSlice"),
      uBlockPx: gl.getUniformLocation(spriteProg, "uBlockPx"),
      uSpriteBlockXY: gl.getUniformLocation(spriteProg, "uSpriteBlockXY"),
      uSpriteSizeBlocks: gl.getUniformLocation(spriteProg, "uSpriteSizeBlocks"),
      uFacingCS: gl.getUniformLocation(spriteProg, "uFacingCS"),
      uSliceZ: gl.getUniformLocation(spriteProg, "uSliceZ"),
      uPlayerTex: gl.getUniformLocation(spriteProg, "uPlayerTex"),
      uPlayerLayer: gl.getUniformLocation(spriteProg, "uPlayerLayer"),
      uIsShadow: gl.getUniformLocation(spriteProg, "uIsShadow"),
      uShadowAlpha: gl.getUniformLocation(spriteProg, "uShadowAlpha"),
      uShowBox: gl.getUniformLocation(spriteProg, "uShowBox"),
    };

    // プレイヤーテクスチャ配列 (8x8 x 36: idle 0..11, stepA 12..23, stepB 24..35)
    const pSliceCount = PLAYER_POSES.rawIdle.length;
    const playerTex = gl.createTexture();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, playerTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 8, 8, pSliceCount * 3);
    const allPoses = [PLAYER_POSES.rawIdle, PLAYER_POSES.rawStepA, PLAYER_POSES.rawStepB];
    for (let p = 0; p < 3; p++) {
      for (let z = 0; z < pSliceCount; z++) {
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          0,
          0,
          p * pSliceCount + z,
          8,
          8,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          allPoses[p][z]
        );
      }
    }
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ワールド地形＆水テクスチャ状態
    let boundWorld = null;
    let boundTerrainKey = "";
    let terrainTex = null;
    let terrainLayers = 0;
    let waterTex = null;
    let uploadedWaterVer = -1;
    let lastPixelated = true;

    function syncTerrainTexture(world, useAO, useEdge) {
      const key = `${useAO ? 1 : 0}_${useEdge ? 1 : 0}`;
      if (boundWorld === world && boundTerrainKey === key && terrainTex) return;

      const pack = world.getSlicePack(useAO, useEdge);
      const layers = world.maxUsedSlice;
      const w = world.canvasW;
      const h = world.canvasH;

      if (terrainTex) gl.deleteTexture(terrainTex);
      terrainTex = gl.createTexture();
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, terrainTex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, w, h, layers);

      const emptyBuf = new Uint8Array(w * h * 4);
      for (let z = 0; z < layers; z++) {
        const bytes = pack.slices[z] || emptyBuf;
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          0,
          0,
          z,
          w,
          h,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          bytes
        );
      }

      const filt = lastPixelated ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      terrainLayers = layers;
      boundTerrainKey = key;
    }

    function syncWaterTexture(world) {
      let uploadedLayers = 0;
      if (boundWorld !== world || !waterTex) {
        if (waterTex) gl.deleteTexture(waterTex);
        waterTex = gl.createTexture();
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, waterTex);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG8, world.sizeX, world.sizeY, world.sizeZ);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        world.dirtyWaterLayers.fill(1);
        uploadedWaterVer = -1;
      }

      const curVer = world.getWaterTexVersion();
      if (curVer !== uploadedWaterVer) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, waterTex);
        for (let bz = 0; bz < world.sizeZ; bz++) {
          if (!world.dirtyWaterLayers[bz]) continue;
          world.dirtyWaterLayers[bz] = 0;
          gl.texSubImage3D(
            gl.TEXTURE_2D_ARRAY,
            0,
            0,
            0,
            bz,
            world.sizeX,
            world.sizeY,
            1,
            gl.RG,
            gl.UNSIGNED_BYTE,
            world.waterLayerBytes[bz]
          );
          uploadedLayers++;
        }
        uploadedWaterVer = curVer;
      }
      return uploadedLayers;
    }

    function updateFilterMode(pixelated) {
      if (pixelated === lastPixelated) return;
      lastPixelated = pixelated;
      const filt = pixelated ? gl.NEAREST : gl.LINEAR;
      if (terrainTex) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, terrainTex);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filt);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filt);
      }
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, playerTex);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filt);
    }

    function render(world, player, cam, settings, timeSec) {
      const t0 = performance.now();

      syncTerrainTexture(world, settings.useAO, settings.useEdgeHighlight);
      const waterUploaded = syncWaterTexture(world);
      boundWorld = world;
      updateFilterMode(settings.pixelated);

      const viewW = canvas.width;
      const viewH = canvas.height;
      const rScale = settings.renderScale || 1.0;

      const effZoom = cam.zoom * rScale;
      const centerX = viewW * 0.5;
      const centerY = viewH * 0.5 + 12 * rScale;

      const pitchRad = (cam.pitchDeg * Math.PI) / 180;
      const squashY = Math.sin(pitchRad);
      const sliceUnitScale = BLOCK_SIZE / BLOCK_SLICES;
      const liftPerSlice = Math.cos(pitchRad) * effZoom * sliceUnitScale * settings.sliceSpacingMult;
      const blockScreenPx = BLOCK_SIZE * effZoom;

      const cosYaw = Math.cos(cam.yaw);
      const sinYaw = Math.sin(cam.yaw);
      const camBaseSlice = cam.z * BLOCK_SLICES;

      let poseIdx = 0;
      if (player.isMoving && player.onGround) {
        const cycle = Math.floor(player.walkCycle * 7) % 4;
        if (cycle === 1) poseIdx = 1;
        else if (cycle === 3) poseIdx = 2;
      } else if (!player.onGround) {
        poseIdx = 1;
      }

      const playerBaseSlice = Math.round(player.z * BLOCK_SLICES);
      const playerMaxSlice = playerBaseSlice + pSliceCount - 1;

      // プレイヤー胴体中心のスクリーン座標（WebGL gl_FragCoord は左下原点なので Y を反転）
      const pRelX = (player.x - cam.x) * blockScreenPx;
      const pRelY = (player.y - cam.y) * blockScreenPx;
      const pScreenX = centerX + (pRelX * cosYaw - pRelY * sinYaw);
      const pBodySlice = player.z * BLOCK_SLICES + pSliceCount * 0.52;
      const pScreenYTopDown =
        centerY - (pBodySlice - camBaseSlice) * liftPerSlice + (pRelX * sinYaw + pRelY * cosYaw) * squashY;
      const pFragY = viewH - pScreenYTopDown;
      const xrayRadiusPx = (settings.xrayRadiusBlocks || 5.0) * blockScreenPx;
      const occlusionFade = settings.occlusionFade || 0;
      const xrayMode = settings.xrayMode !== undefined ? settings.xrayMode : 0;

      const floorInfo = world.findFloorBelow(player.x, player.y, player.z + 0.05);
      const shadowSliceZ = Math.round(floorInfo.floorZ * BLOCK_SLICES);

      const fullTopSlice = Math.max(world.maxUsedSlice, playerMaxSlice + 1);
      const limitZ =
        settings.maxVisibleSlice >= world.maxUsedSlice
          ? fullTopSlice
          : settings.maxVisibleSlice;

      // 画面4隅を最下層(0)と最上層(limitZ-1)へ逆投影して全体の可視ブロック矩形を求める
      const invBlockPx = 1 / blockScreenPx;
      const invSquashY = 1 / squashY;
      let minBx = world.sizeX;
      let maxBx = 0;
      let minBy = world.sizeY;
      let maxBy = 0;
      const testSlices = [0, Math.max(0, limitZ - 1)];
      for (let s = 0; s < 2; s++) {
        const oy = centerY - (testSlices[s] - camBaseSlice) * liftPerSlice;
        const dx0 = -centerX;
        const dx1 = viewW - centerX;
        const dy0 = -oy * invSquashY;
        const dy1 = (viewH - oy) * invSquashY;
        const corners = [
          [dx0, dy0],
          [dx1, dy0],
          [dx0, dy1],
          [dx1, dy1],
        ];
        for (let c = 0; c < 4; c++) {
          const vx = corners[c][0];
          const vy = corners[c][1];
          const bx = cam.x + (vx * cosYaw + vy * sinYaw) * invBlockPx;
          const by = cam.y + (-vx * sinYaw + vy * cosYaw) * invBlockPx;
          if (bx < minBx) minBx = bx;
          if (bx > maxBx) maxBx = bx;
          if (by < minBy) minBy = by;
          if (by > maxBy) maxBy = by;
        }
      }
      minBx = Math.max(0, Math.floor(minBx) - 1);
      maxBx = Math.min(world.sizeX, Math.ceil(maxBx) + 1);
      minBy = Math.max(0, Math.floor(minBy) - 1);
      maxBy = Math.min(world.sizeY, Math.ceil(maxBy) + 1);

      const cropRatio =
        maxBx > minBx && maxBy > minBy
          ? ((maxBx - minBx) * (maxBy - minBy)) / (world.sizeX * world.sizeY)
          : 0;

      gl.viewport(0, 0, viewW, viewH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.bindVertexArray(vao);

      // 共通 uniform 設定用ヘルパー
      let worldDrawCalls = 0;
      let waterDrawCalls = 0;
      let miscDrawCalls = 0;
      let currentProg = null;

      function useWorldProgram() {
        if (currentProg === worldProg) return;
        currentProg = worldProg;
        gl.useProgram(worldProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, terrainTex);
        gl.uniform1i(wLoc.uTerrainTex, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, waterTex);
        gl.uniform1i(wLoc.uWaterTex, 1);

        gl.uniform2f(wLoc.uViewport, viewW, viewH);
        gl.uniform2f(wLoc.uCenter, centerX, centerY);
        gl.uniform2f(wLoc.uCamXY, cam.x, cam.y);
        gl.uniform1f(wLoc.uCamBaseSlice, camBaseSlice);
        gl.uniform2f(wLoc.uYawCS, cosYaw, sinYaw);
        gl.uniform1f(wLoc.uSquashY, squashY);
        gl.uniform1f(wLoc.uLiftPerSlice, liftPerSlice);
        gl.uniform1f(wLoc.uBlockPx, blockScreenPx);
        gl.uniform4f(wLoc.uCropBlocks, minBx, minBy, maxBx, maxBy);
        gl.uniform2f(wLoc.uWorldSize, world.sizeX, world.sizeY);
        gl.uniform1i(wLoc.uWorldZ, world.sizeZ);
        gl.uniform1i(wLoc.uTerrainLayers, terrainLayers);
        gl.uniform1f(wLoc.uTime, timeSec);
        gl.uniform1i(wLoc.uWireframe, settings.showWireframe ? 1 : 0);
        gl.uniform2f(wLoc.uPlayerScreenPos, pScreenX, pFragY);
        gl.uniform3f(wLoc.uPlayerWorldPos, player.x, player.y, player.z);
        gl.uniform1i(wLoc.uPlayerBaseSlice, playerBaseSlice);
        gl.uniform1f(wLoc.uOcclusionFade, occlusionFade);
        gl.uniform1f(wLoc.uXrayRadiusPx, xrayRadiusPx);
        gl.uniform1i(wLoc.uXrayMode, xrayMode);
      }

      function useSpriteProgram() {
        if (currentProg === spriteProg) return;
        currentProg = spriteProg;
        gl.useProgram(spriteProg);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, playerTex);
        gl.uniform1i(sLoc.uPlayerTex, 2);

        gl.uniform2f(sLoc.uViewport, viewW, viewH);
        gl.uniform2f(sLoc.uCenter, centerX, centerY);
        gl.uniform2f(sLoc.uCamXY, cam.x, cam.y);
        gl.uniform1f(sLoc.uCamBaseSlice, camBaseSlice);
        gl.uniform2f(sLoc.uYawCS, cosYaw, sinYaw);
        gl.uniform1f(sLoc.uSquashY, squashY);
        gl.uniform1f(sLoc.uLiftPerSlice, liftPerSlice);
        gl.uniform1f(sLoc.uBlockPx, blockScreenPx);
        gl.uniform2f(sLoc.uSpriteBlockXY, player.x, player.y);
        gl.uniform2f(sLoc.uFacingCS, Math.cos(player.facing), Math.sin(player.facing));
      }

      function drawWorldBatch(startZ, count, mode) {
        if (count <= 0 || cropRatio <= 0) return;
        useWorldProgram();
        gl.uniform1i(wLoc.uStartSlice, startZ);
        gl.uniform1i(wLoc.uMode, mode);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
        if (mode === 2) waterDrawCalls++;
        else worldDrawCalls++;
      }

      function drawShadowQuad() {
        if (floorInfo.floorZ <= 0 || shadowSliceZ >= limitZ) return;
        const heightAboveFloor = Math.max(0, player.z - floorInfo.floorZ);
        const shadowScale = Math.max(0.45, 1 - heightAboveFloor * 0.22);
        useSpriteProgram();
        gl.uniform1i(sLoc.uIsShadow, 1);
        gl.uniform1f(sLoc.uShadowAlpha, 0.34 * shadowScale);
        gl.uniform1f(sLoc.uSpriteSizeBlocks, 0.72 * shadowScale);
        gl.uniform1i(sLoc.uSliceZ, shadowSliceZ);
        gl.uniform1i(sLoc.uShowBox, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        miscDrawCalls++;
      }

      // ============================================================
      // 【超軽量インターリーブ描画】
      //  1) プレイヤー足元より下を一括 1〜2 インスタンスコールで描画
      //  2) プレイヤーの存在する12層のみ層ごとに地形→プレイヤー→水を描画
      //  3) プレイヤー頭上（岩山・トンネル天井・木）を一括 1 インスタンスコールで描画！
      // ============================================================
      const pStart = Math.max(0, Math.min(limitZ, playerBaseSlice));
      const pEnd = Math.max(pStart, Math.min(limitZ, playerMaxSlice + 1));

      // 1) プレイヤーより下の層（接地影がプレイヤーより下にある場合は影の位置で分割）
      if (floorInfo.floorZ > 0 && shadowSliceZ < pStart) {
        drawWorldBatch(0, shadowSliceZ, 0);
        drawWorldBatch(shadowSliceZ, 1, 1); // 床天面
        drawShadowQuad();
        drawWorldBatch(shadowSliceZ, 1, 2); // 床面上の水
        drawWorldBatch(shadowSliceZ + 1, pStart - (shadowSliceZ + 1), 0);
      } else {
        drawWorldBatch(0, pStart, 0);
      }

      // 2) プレイヤー帯 (最大12スライス)
      for (let z = pStart; z < pEnd; z++) {
        // 地形のみ
        drawWorldBatch(z, 1, 1);

        // 影（足元と同じ高さにある場合）
        if (z === shadowSliceZ && floorInfo.floorZ > 0) {
          drawShadowQuad();
        }

        // プレイヤースライス
        useSpriteProgram();
        gl.uniform1i(sLoc.uIsShadow, 0);
        gl.uniform1i(sLoc.uPlayerLayer, poseIdx * pSliceCount + (z - playerBaseSlice));
        gl.uniform1f(sLoc.uSpriteSizeBlocks, 0.96);
        gl.uniform1i(sLoc.uSliceZ, z);
        gl.uniform1i(sLoc.uShowBox, settings.showWireframe && (z - playerBaseSlice) % 3 === 0 ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        miscDrawCalls++;

        // 水のみ（プレイヤーより後に描くことで水中では半透明の水に透けて見える）
        drawWorldBatch(z, 1, 2);
      }

      // 3) プレイヤーより上の層すべてを 1 回の drawArraysInstanced で一括描画！
      if (pEnd < limitZ) {
        drawWorldBatch(pEnd, limitZ - pEnd, 0);
      }

      gl.bindVertexArray(null);

      return {
        backend: "WebGL2",
        renderMs: performance.now() - t0,
        worldDrawCalls,
        waterDrawCalls,
        miscDrawCalls,
        totalDrawCalls: worldDrawCalls + waterDrawCalls + miscDrawCalls,
        drawnSlices: limitZ,
        culledSlices: Math.max(0, world.maxUsedSlice - limitZ),
        totalSlices: world.maxUsedSlice,
        cropRatio,
        waterUploaded,
      };
    }

    return { render };
  }

  /**
   * 右側観察パネル用：単体モデルのスタッキング描画（軽量なCanvas 2Dのまま維持）
   */
  function drawSingleModelPreview(ctx, model, opts) {
    const pitchRad = (opts.pitchDeg * Math.PI) / 180;
    const squashY = Math.sin(pitchRad);
    const scale = opts.scale;
    const sliceUnitScale = model.id === "player" ? 1.0 : BLOCK_SIZE / BLOCK_SLICES;
    const liftPerSlice = Math.cos(pitchRad) * scale * sliceUnitScale * opts.sliceSpacingMult;

    const drawW = model.width * scale;
    const drawH = model.height * scale;

    ctx.imageSmoothingEnabled = !opts.pixelated;

    ctx.save();
    ctx.translate(opts.x, opts.y + 4);
    ctx.scale(1, squashY);
    ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
    ctx.beginPath();
    ctx.ellipse(0, 0, drawW * 0.55, drawH * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    for (let z = 0; z < model.layerCount; z++) {
      const sy = opts.y - z * liftPerSlice;
      ctx.save();
      ctx.translate(opts.x, sy);
      ctx.scale(1, squashY);
      ctx.rotate(opts.angle);

      const hasHl = opts.highlightLayer !== null && opts.highlightLayer !== undefined;
      if (hasHl && z !== opts.highlightLayer) {
        ctx.globalAlpha = 0.22;
      }

      ctx.drawImage(model.canvases[z], -drawW / 2, -drawH / 2, drawW, drawH);

      if (opts.showWireframe || (hasHl && z === opts.highlightLayer)) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = hasHl && z === opts.highlightLayer ? "#fbbf24" : "rgba(255,255,255,0.28)";
        ctx.lineWidth = hasHl && z === opts.highlightLayer ? 1.8 : 1;
        ctx.strokeRect(-drawW / 2, -drawH / 2, drawW, drawH);
      }

      ctx.restore();
    }
  }

  global.VoxelWalk = global.VoxelWalk || {};
  global.VoxelWalk.createWebGLRenderer = createWebGLRenderer;
  global.VoxelWalk.drawSingleModelPreview = drawSingleModelPreview;
})(window);
