/**
 * renderer.js
 * ------------------------------------------------------------
 * WebGL2 インスタンシング・スプライトスタッキング描画エンジン！
 *
 * 【機能】
 * - 128x128x14 地形 TEXTURE_2D_ARRAY (RGBA8)
 * - 水＋溶岩＋松明フラグ TEXTURE_2D_ARRAY (RG8)
 * - 3D ライトマップ TEXTURE_3D (RG8, LINEAR補間): R=blockLight(松明/溶岩 0..15), G=skyLight(太陽光 0..15)
 * - 昼夜サイクル対応（夜はほぼ真っ暗、松明と溶岩が16ブロック先まで暖かく照らす）
 * - 60fps 連続 Worley/Voronoi 水面コースティクス ＋ 溶岩マグマアニメーション ＋ 揺れる松明の炎
 * - 洞窟・崖裏の X-Ray 外表面透視カットアウト
 */
(function (global) {
  "use strict";

  const { BLOCK_SIZE, BLOCK_SLICES, PLAYER_POSES } = global.VoxelWalk;

  const WORLD_VS = `#version 300 es
    precision highp float;

    layout(location = 0) in vec2 aQuadPos;

    uniform vec2 uViewport;
    uniform vec2 uCenter;
    uniform vec2 uCamXY;
    uniform float uCamBaseSlice;
    uniform vec2 uYawCS;
    uniform float uSquashY;
    uniform float uLiftPerSlice;
    uniform float uBlockPx;
    uniform vec4 uCropBlocks;
    uniform vec2 uWorldSize;
    uniform int uStartSlice;

    out vec2 vBlockPos;
    flat out int vSliceZ;

    void main() {
      int sliceZ = uStartSlice + gl_InstanceID;
      vSliceZ = sliceZ;

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
    precision highp sampler3D;

    uniform sampler2DArray uTerrainTex; // 768x768 x N slices (RGBA8)
    uniform sampler2DArray uWaterTex;   // 128x128 x 14 layers (RG8: R=visLevel 0..8, G=flags: 1=fall, 2=solid, 4=lava, 8=torch, 16=tree, 32=leaves)
    uniform sampler3D uLightTex;        // 128x128 x 14 (RG8, LINEAR: R=blockLight, G=skyLight)
    uniform sampler2D uTreeSwayTex;     // 128x128 (RGBA8, NEAREST: RG=swayXY, B=(baseBz<<4)|heightBlocks, A=hitEnergy)
    uniform vec2 uYawCS;                // 隣接する葉ブロック重なり時の前後ソート用

    uniform vec2 uWorldSize;
    uniform int uWorldZ;
    uniform int uTerrainLayers;
    uniform float uTime;
    uniform int uMode;                  // 0=地形+水+松明, 1=地形のみ, 2=水+松明のみ
    uniform int uWireframe;

    // 昼夜ライティング
    uniform float uSunBrightness;       // 昼 1.0 -> 夜 0.035
    uniform vec3 uSkyLightColor;        // 昼:白, 夕:オレンジ, 夜:深い紺

    // 洞窟・遮蔽時の X-Ray 透視カットアウト
    uniform vec2 uPlayerScreenPos;
    uniform vec3 uPlayerWorldPos;
    uniform int uPlayerBaseSlice;
    uniform float uBlockPx;
    uniform float uOcclusionFade;
    uniform float uXrayRadiusPx;
    uniform int uXrayMode;              // 0=地形輪郭のみ, 1=うっすら半透明, 2=完全切り抜き

    in vec2 vBlockPos;
    flat in int vSliceZ;

    out vec4 outColor;

    vec2 hash22(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.xx + p3.yz) * p3.zy);
    }

    vec2 waterCaustic(vec2 blockPos, float t) {
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
          float dist = length(pt - fp);
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

    // 溶岩マグマのゆっくり脈打つ自己発光カラー
    vec3 lavaColor(vec2 blockPos, float t) {
      vec2 wp = floor(blockPos * 4.0) * 0.25;
      float v1 = sin(wp.x * 2.1 + t * 0.9 + sin(wp.y * 1.7 - t * 0.6));
      float v2 = cos(wp.y * 2.4 - t * 0.7 + cos(wp.x * 1.9 + t * 0.5));
      float heat = (v1 * 0.5 + v2 * 0.5) * 0.5 + 0.5;
      vec3 darkCrust = vec3(0.68, 0.14, 0.03);
      vec3 moltenOrange = vec3(1.0, 0.44, 0.06);
      vec3 brightCore = vec3(1.0, 0.88, 0.34);
      if (heat < 0.55) {
        return mix(darkCrust, moltenOrange, heat / 0.55);
      }
      return mix(moltenOrange, brightCore, (heat - 0.55) / 0.45);
    }

    ivec2 sampleWaterCell(ivec2 bxy, int bz) {
      if (bz < 0 || bz >= uWorldZ || bxy.x < 0 || bxy.y < 0 || bxy.x >= int(uWorldSize.x) || bxy.y >= int(uWorldSize.y)) {
        return ivec2(0, 0);
      }
      vec2 rg = texelFetch(uWaterTex, ivec3(bxy, bz), 0).rg;
      return ivec2(int(floor(rg.r * 255.0 + 0.5)), int(floor(rg.g * 255.0 + 0.5)));
    }

    // 3D ライトマップから滑らかな総合照明カラー（太陽光＋16ブロック到達の光源光）を計算
    vec3 evalWorldLight(vec2 blockPos, int sliceZ) {
      vec3 luv = vec3(
        blockPos.x / uWorldSize.x,
        blockPos.y / uWorldSize.y,
        clamp((float(sliceZ) / 8.0 + 0.5) / float(uWorldZ), 0.0, 1.0)
      );
      vec2 ls = texture(uLightTex, luv).rg; // r = blockLight (0..1), g = skyLight (0..1)

      // Minecraft 風の知覚カーブ（0で完全に暗く、15でしっかり明るい）
      float bL = pow(ls.r, 1.55);
      float sL = pow(ls.g, 1.35) * uSunBrightness;

      // 松明・溶岩の暖色光にわずかな炎のゆらぎを足す
      float flicker = 0.965 + 0.035 * sin(uTime * 6.8 + blockPos.x * 1.3 + blockPos.y * 1.7);
      vec3 blockCol = vec3(1.12, 0.78, 0.42) * bL * flicker;
      vec3 skyCol = uSkyLightColor * sL;

      // 夜・深洞窟はほぼ真っ暗（わずかな月明かりベース 0.014 のみ）
      vec3 baseDark = vec3(0.012, 0.016, 0.026);
      return min(vec3(1.22), baseDark + skyCol + blockCol * (1.0 - sL * 0.42));
    }

    // 1ブロック丸ごと形を崩さず剛体として揺らすための、ブロックごとの独立変位を計算
    // （同じブロックの全8スライス＋上面キャップが完全に同じ変位を共有するため波打たない！）
    vec2 computeRigidTreeBlockOffset(ivec2 cell, int ownerBz, bool isLeaf, vec4 treeInfo) {
      int meta = int(floor(treeInfo.b * 255.0 + 0.5));
      int baseBz = meta >> 4;
      int heightBlocks = max(1, meta & 15);
      int relZ = ownerBz - baseBz;
      if (relZ <= 0 && !isLeaf) {
        // 地面に接する幹の一番下は完全固定
        return vec2(0.0);
      }

      float hNorm = clamp(float(relZ) / max(1.0, float(heightBlocks - 1)), 0.0, 1.0);
      vec2 treeSway = ((treeInfo.rg * 255.0 - 128.0) / 127.0) * 0.36;
      float hitEnergy = treeInfo.a;

      // 幹は控えめに剛体シフト、葉は木全体のしなり＋各ブロック固有のランダム方向へ独立に揺れる
      vec2 disp = treeSway * (isLeaf ? (0.45 + 0.55 * hNorm) : (hNorm * 0.35));

      if (isLeaf) {
        vec2 h2 = hash22(vec2(cell) + vec2(float(ownerBz) * 19.7, float(ownerBz) * 37.3));
        float ang = h2.x * 6.2831853;
        float phase = h2.y * 6.2831853;
        vec2 dirA = vec2(cos(ang), sin(ang));
        vec2 dirB = vec2(-dirA.y, dirA.x);

        // そよ風：ブロックごとに異なる向きへゆったり独立揺れ（多方向で自然！）
        float freqA = 1.65 + h2.x * 0.95;
        float freqB = 1.15 + h2.y * 0.75;
        vec2 leafWind =
          dirA * (sin(uTime * freqA + phase) * 0.085) +
          dirB * (cos(uTime * freqB + phase * 1.3) * 0.055);

        // プレイヤー衝突時：ブロックごとにバラバラの方向へ元気にガサガサ弾む！（サイン波的なうねりなし）
        float hitFreq = 14.0 + h2.y * 6.5;
        float hitAmp = hitEnergy * hitEnergy * 0.24;
        vec2 leafHit =
          dirA * (sin(uTime * hitFreq + phase) * hitAmp) +
          dirB * (cos(uTime * (hitFreq * 0.83) + ang) * (hitAmp * 0.72));

        disp += leafWind + leafHit;
      }

      // 2x2 近傍探索で漏れゼロを保証するため最大 ±0.44 ブロックにクランプ
      return clamp(disp, vec2(-0.44), vec2(0.44));
    }

    void main() {
      vec2 uv = vBlockPos / uWorldSize;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;

      int bz = vSliceZ / 8;
      int lz = vSliceZ - bz * 8;
      ivec2 bxy = ivec2(floor(vBlockPos));

      // 1. 固体地形スライス評価（各木ブロックが形を崩さず剛体として独立に揺れる 2x2 探索）
      if (uMode != 2 && vSliceZ < uTerrainLayers) {
        bool isBlockPlane = (lz == 0);
        int curFlags = sampleWaterCell(bxy, bz).y;

        vec4 tCol = vec4(0.0);
        bool drewTree = false;
        ivec2 effBxy = bxy;
        int effFlags = curFlags;
        vec2 effBlockPos = vBlockPos;

        ivec2 clampedBxy = clamp(bxy, ivec2(0), ivec2(uWorldSize) - 1);
        vec4 treeInfo = texelFetch(uTreeSwayTex, clampedBxy, 0);
        int treeMeta = int(floor(treeInfo.b * 255.0 + 0.5));
        if (treeMeta > 0) {
          int treeBaseSlice = (treeMeta >> 4) * 8;
          if (vSliceZ >= treeBaseSlice) {
            vec2 fxy = fract(vBlockPos);
            int stepX = (fxy.x < 0.5) ? -1 : 1;
            int stepY = (fxy.y < 0.5) ? -1 : 1;
            float bestDepth = -1e9;

            for (int k = 0; k < 4; k++) {
              int ox = (k == 1 || k == 3) ? stepX : 0;
              int oy = (k == 2 || k == 3) ? stepY : 0;
              ivec2 cand = bxy + ivec2(ox, oy);
              if (cand.x < 0 || cand.y < 0 || cand.x >= int(uWorldSize.x) || cand.y >= int(uWorldSize.y)) {
                continue;
              }

              int cFlags = sampleWaterCell(cand, bz).y;
              int ownerBz = -1;
              bool isLeaf = false;
              if ((cFlags & 16) != 0) {
                ownerBz = bz;
                isLeaf = (cFlags & 32) != 0;
              } else if (isBlockPlane && bz > 0 && (cFlags & 2) == 0) {
                int belowFlags = sampleWaterCell(cand, bz - 1).y;
                if ((belowFlags & 16) != 0) {
                  ownerBz = bz - 1;
                  isLeaf = (belowFlags & 32) != 0;
                }
              }
              if (ownerBz < 0) continue;

              vec4 candTree = texelFetch(uTreeSwayTex, cand, 0);
              if (int(floor(candTree.b * 255.0 + 0.5)) == 0) continue;

              vec2 disp = computeRigidTreeBlockOffset(cand, ownerBz, isLeaf, candTree);
              vec2 local = vBlockPos - (vec2(cand) + disp);
              if (local.x >= 0.0 && local.x < 1.0 && local.y >= 0.0 && local.y < 1.0) {
                float camDepth = float(cand.x) * uYawCS.y + float(cand.y) * uYawCS.x;
                if (camDepth > bestDepth) {
                  vec2 srcBlockPos = vec2(cand) + clamp(local, vec2(0.002), vec2(0.998));
                  vec4 candCol = texture(uTerrainTex, vec3(srcBlockPos / uWorldSize, float(vSliceZ)));
                  if (candCol.a > 0.5) {
                    bestDepth = camDepth;
                    tCol = candCol;
                    drewTree = true;
                    effBxy = cand;
                    effFlags = cFlags;
                    effBlockPos = srcBlockPos;
                  }
                }
              }
            }
          }
        }

        // 木以外の通常地形（元の位置に残る木のゴーストは描かない）
        if (!drewTree) {
          bool curIsTree = (curFlags & 16) != 0;
          if (!curIsTree && isBlockPlane && bz > 0 && (curFlags & 2) == 0) {
            curIsTree = (sampleWaterCell(bxy, bz - 1).y & 16) != 0;
          }
          if (!curIsTree) {
            tCol = texture(uTerrainTex, vec3(uv, float(vSliceZ)));
          }
        }

        if (tCol.a > 0.5) {
          // 溶岩ブロック判定（自己発光アニメーション：夜でも真っ赤に輝く！）
          bool isLava = !drewTree && (curFlags & 4) != 0;
          if (!drewTree && !isLava && isBlockPlane && bz > 0 && (curFlags & 2) == 0) {
            isLava = (sampleWaterCell(bxy, bz - 1).y & 4) != 0;
          }

          vec3 finalRgb;
          if (isLava) {
            finalRgb = lavaColor(vBlockPos, uTime) * (isBlockPlane ? 1.12 : 0.92);
          } else {
            if (uWireframe == 1 && isBlockPlane) {
              vec2 edgeDist = min(vBlockPos, uWorldSize - vBlockPos);
              if (min(edgeDist.x, edgeDist.y) < 0.12) {
                tCol.rgb = mix(tCol.rgb, vec3(1.0), 0.35);
              }
            }
            vec3 lightCol = evalWorldLight(vBlockPos, vSliceZ);
            finalRgb = tCol.rgb * lightCol;
          }

          // 洞窟・崖裏の X-Ray 透視処理（プレイヤーより上の遮蔽ブロックのみ外表面輪郭/半透明化）
          if (uOcclusionFade > 0.01) {
            float screenDist = length(gl_FragCoord.xy - uPlayerScreenPos);
            int cutSlice = (screenDist < uBlockPx * 1.35) ? (uPlayerBaseSlice + 4) : (uPlayerBaseSlice + 12);

            if (vSliceZ >= cutSlice && screenDist < uXrayRadiusPx) {
              float mask = (1.0 - smoothstep(uXrayRadiusPx * 0.78, uXrayRadiusPx, screenDist)) * uOcclusionFade;
              if (mask > 0.15) {
                if (uXrayMode == 2) {
                  if (mask > 0.45) discard;
                  outColor = vec4(finalRgb, 1.0 - mask * 1.6);
                  return;
                }

                bool isExposedRoof =
                  isBlockPlane &&
                  bz > 0 &&
                  ((sampleWaterCell(effBxy, bz - 1).y & 2) != 0) &&
                  ((effFlags & 2) == 0);

                if (uXrayMode == 1) {
                  if (isExposedRoof) {
                    outColor = vec4(finalRgb, mix(1.0, 0.18, mask));
                    return;
                  }
                  if (mask > 0.45) discard;
                  outColor = vec4(finalRgb, 1.0 - mask * 1.6);
                  return;
                } else {
                  if (isExposedRoof) {
                    int roofBz = bz - 1;
                    vec2 fxy = fract(effBlockPos);
                    bool edgeW = fxy.x < 0.16 && ((sampleWaterCell(effBxy + ivec2(-1, 0), roofBz).y & 2) == 0);
                    bool edgeE = fxy.x > 0.84 && ((sampleWaterCell(effBxy + ivec2(1, 0), roofBz).y & 2) == 0);
                    bool edgeN = fxy.y < 0.16 && ((sampleWaterCell(effBxy + ivec2(0, -1), roofBz).y & 2) == 0);
                    bool edgeS = fxy.y > 0.84 && ((sampleWaterCell(effBxy + ivec2(0, 1), roofBz).y & 2) == 0);
                    if (edgeW || edgeE || edgeN || edgeS) {
                      vec3 contourCol = mix(finalRgb + vec3(0.18), vec3(0.60, 0.88, 1.0), 0.55);
                      outColor = vec4(contourCol, 0.42 * mask + (1.0 - mask));
                      return;
                    }
                    if (screenDist > uXrayRadiusPx * 0.92) {
                      outColor = vec4(finalRgb, (1.0 - mask) * 0.7);
                      return;
                    }
                    discard;
                  }
                  if (mask > 0.45) discard;
                  outColor = vec4(finalRgb, 1.0 - mask * 1.6);
                  return;
                }
              }
            }
          }

          outColor = vec4(finalRgb, 1.0);
          return;
        }
      }

      if (uMode == 1) discard;

      ivec2 curW = sampleWaterCell(bxy, bz);
      int visLevel = curW.x;
      int flags = curW.y;
      bool curSolid = (flags & 2) != 0;
      bool isFalling = (flags & 1) != 0;
      bool isTorch = (flags & 8) != 0;

      // 2. 設置された松明の 3D 描画（木の柄＋ゆらめく自己発光の炎！）
      if (isTorch && bz < uWorldZ) {
        vec2 fxy = fract(vBlockPos) - 0.5;
        if (lz <= 4) {
          // 木の柄
          if (abs(fxy.x) < 0.11 && abs(fxy.y) < 0.11) {
            outColor = vec4(0.58, 0.36, 0.16, 1.0);
            return;
          }
        } else if (lz <= 7) {
          // 揺れる炎（自己発光）
          float swayX = sin(uTime * 11.0 + vBlockPos.x * 7.0) * 0.03 * float(lz - 4);
          float swayY = cos(uTime * 9.5 + vBlockPos.y * 5.0) * 0.03 * float(lz - 4);
          float dFlame = length(fxy - vec2(swayX, swayY));
          float rMax = 0.21 - float(lz - 5) * 0.045;
          if (dFlame < rMax) {
            vec3 flameCol = dFlame < rMax * 0.55 ? vec3(1.0, 0.96, 0.65) : vec3(1.0, 0.56, 0.12);
            outColor = vec4(flameCol, 1.0);
            return;
          }
        }
      }

      // 3. 水スライス評価（昼夜＆松明・溶岩の光も反映！）
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

        vec3 lightCol = evalWorldLight(vBlockPos, vSliceZ);
        outColor = vec4(rgb * lightCol, alpha);
        return;
      }

      if (bz < uWorldZ && visLevel >= lz + 1) {
        vec3 lightCol = evalWorldLight(vBlockPos, vSliceZ);
        if (isFalling) {
          float streak = 0.85 + 0.15 * sin(uTime * 9.0 + float(vSliceZ) * 0.9 + vBlockPos.x * 3.0);
          outColor = vec4(vec3(0.34, 0.78, 0.95) * streak * lightCol, 0.25);
        } else {
          outColor = vec4(vec3(0.04, 0.36, 0.68) * lightCol, 0.078);
        }
        return;
      }

      discard;
    }
  `;

  // プレイヤー＆接地影用シェーダー（同じ 3D ライトマップで照らす）
  const SPRITE_VS = `#version 300 es
    precision highp float;

    layout(location = 0) in vec2 aQuadPos;

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
    uniform vec3 uPlayerTint;

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
      outColor = vec4(col.rgb * uPlayerTint, col.a);
    }
  `;

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
      uLightTex: gl.getUniformLocation(worldProg, "uLightTex"),
      uTreeSwayTex: gl.getUniformLocation(worldProg, "uTreeSwayTex"),
      uWorldZ: gl.getUniformLocation(worldProg, "uWorldZ"),
      uTerrainLayers: gl.getUniformLocation(worldProg, "uTerrainLayers"),
      uTime: gl.getUniformLocation(worldProg, "uTime"),
      uMode: gl.getUniformLocation(worldProg, "uMode"),
      uWireframe: gl.getUniformLocation(worldProg, "uWireframe"),
      uSunBrightness: gl.getUniformLocation(worldProg, "uSunBrightness"),
      uSkyLightColor: gl.getUniformLocation(worldProg, "uSkyLightColor"),
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
      uPlayerTint: gl.getUniformLocation(spriteProg, "uPlayerTint"),
    };

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

    let boundWorld = null;
    let boundTerrainKey = "";
    let terrainTex = null;
    let terrainLayers = 0;
    let waterTex = null;
    let uploadedWaterVer = -1;
    let lightTex = null;
    let uploadedLightVer = -1;
    let treeSwayTex = null;
    let uploadedTreeSwayVer = -1;
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
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, z, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
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

    function syncLightTexture(world) {
      if (boundWorld !== world || !lightTex) {
        if (lightTex) gl.deleteTexture(lightTex);
        lightTex = gl.createTexture();
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.bindTexture(gl.TEXTURE_3D, lightTex);
        gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RG8, world.sizeX, world.sizeY, world.sizeZ);
        // GL_LINEAR で滑らかな Minecraft 風スムースライティングを実現！
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
        uploadedLightVer = -1;
      }

      const curVer = world.getLightTexVersion();
      if (curVer !== uploadedLightVer) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.bindTexture(gl.TEXTURE_3D, lightTex);
        gl.texSubImage3D(
          gl.TEXTURE_3D,
          0,
          0,
          0,
          0,
          world.sizeX,
          world.sizeY,
          world.sizeZ,
          gl.RG,
          gl.UNSIGNED_BYTE,
          world.lightTexBytes
        );
        uploadedLightVer = curVer;
      }
    }

    function syncTreeSwayTexture(world) {
      if (boundWorld !== world || !treeSwayTex) {
        if (treeSwayTex) gl.deleteTexture(treeSwayTex);
        treeSwayTex = gl.createTexture();
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.bindTexture(gl.TEXTURE_2D, treeSwayTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, world.sizeX, world.sizeY);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        uploadedTreeSwayVer = -1;
      }

      const curVer = world.getTreeSwayVersion();
      if (curVer !== uploadedTreeSwayVer) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.bindTexture(gl.TEXTURE_2D, treeSwayTex);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          world.sizeX,
          world.sizeY,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          world.treeSwayBytes
        );
        uploadedTreeSwayVer = curVer;
      }
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
      syncLightTexture(world);
      syncTreeSwayTexture(world);
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

      const sunBrightness = settings.sunBrightness !== undefined ? settings.sunBrightness : 1.0;
      const skyLightColor = settings.skyLightColor || [1.0, 0.99, 0.96];

      // プレイヤー自身の受光色（真っ暗な夜でもキャラの位置がうっすら分かる最小値 0.14 を確保）
      const pLight = world.getLightAt(player.x, player.y, player.z + 0.8);
      const pbL = Math.pow(pLight.block / 15, 1.55);
      const psL = Math.pow(pLight.sky / 15, 1.35) * sunBrightness;
      const pTintR = Math.min(1.2, Math.max(0.14, skyLightColor[0] * psL + 1.12 * pbL * (1 - psL * 0.4)));
      const pTintG = Math.min(1.2, Math.max(0.15, skyLightColor[1] * psL + 0.78 * pbL * (1 - psL * 0.4)));
      const pTintB = Math.min(1.2, Math.max(0.20, skyLightColor[2] * psL + 0.44 * pbL * (1 - psL * 0.4)));

      const floorInfo = world.findFloorBelow(player.x, player.y, player.z + 0.05);
      const shadowSliceZ = Math.round(floorInfo.floorZ * BLOCK_SLICES);

      const fullTopSlice = Math.max(world.maxUsedSlice, playerMaxSlice + 1);
      const limitZ =
        settings.maxVisibleSlice >= world.maxUsedSlice
          ? fullTopSlice
          : settings.maxVisibleSlice;

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
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_3D, lightTex);
        gl.uniform1i(wLoc.uLightTex, 3);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, treeSwayTex);
        gl.uniform1i(wLoc.uTreeSwayTex, 4);

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
        gl.uniform1f(wLoc.uSunBrightness, sunBrightness);
        gl.uniform3f(wLoc.uSkyLightColor, skyLightColor[0], skyLightColor[1], skyLightColor[2]);
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
        gl.uniform3f(sLoc.uPlayerTint, pTintR, pTintG, pTintB);
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
        gl.uniform1f(sLoc.uShadowAlpha, 0.34 * shadowScale * Math.max(0.25, sunBrightness));
        gl.uniform1f(sLoc.uSpriteSizeBlocks, 0.72 * shadowScale);
        gl.uniform1i(sLoc.uSliceZ, shadowSliceZ);
        gl.uniform1i(sLoc.uShowBox, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        miscDrawCalls++;
      }

      const pStart = Math.max(0, Math.min(limitZ, playerBaseSlice));
      const pEnd = Math.max(pStart, Math.min(limitZ, playerMaxSlice + 1));

      if (floorInfo.floorZ > 0 && shadowSliceZ < pStart) {
        drawWorldBatch(0, shadowSliceZ, 0);
        drawWorldBatch(shadowSliceZ, 1, 1);
        drawShadowQuad();
        drawWorldBatch(shadowSliceZ, 1, 2);
        drawWorldBatch(shadowSliceZ + 1, pStart - (shadowSliceZ + 1), 0);
      } else {
        drawWorldBatch(0, pStart, 0);
      }

      for (let z = pStart; z < pEnd; z++) {
        drawWorldBatch(z, 1, 1);

        if (z === shadowSliceZ && floorInfo.floorZ > 0) {
          drawShadowQuad();
        }

        useSpriteProgram();
        gl.uniform1i(sLoc.uIsShadow, 0);
        gl.uniform1i(sLoc.uPlayerLayer, poseIdx * pSliceCount + (z - playerBaseSlice));
        gl.uniform1f(sLoc.uSpriteSizeBlocks, 0.96);
        gl.uniform1i(sLoc.uSliceZ, z);
        gl.uniform1i(sLoc.uShowBox, settings.showWireframe && (z - playerBaseSlice) % 3 === 0 ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        miscDrawCalls++;

        drawWorldBatch(z, 1, 2);
      }

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
