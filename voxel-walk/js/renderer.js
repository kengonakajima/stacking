/**
 * renderer.js
 * ------------------------------------------------------------
 * 128x128 ボクセルワールド（マルチバイオーム地形・木・オーバーハング・トンネル）＋
 * 半透明 Worley/Voronoi アニメ水 ＋ プレイヤーをスプライトスタッキングで描画し、
 * ドローコール数・描画スライス数・画面クロップ率などの詳細な描画統計を計測して返します。
 */
(function (global) {
  "use strict";

  const { BLOCK_SIZE, BLOCK_SLICES, PLAYER_POSES, buildWaterAnimFrames } = global.VoxelWalk;

  const WATER_PX_PER_BLOCK = 4;
  let waterAnimFrames = null;
  let surfaceScratch = null;
  let surfaceScratchCtx = null;

  function ensureWaterAnimResources(world) {
    if (!waterAnimFrames || waterAnimFrames[0].width !== world.sizeX * WATER_PX_PER_BLOCK) {
      waterAnimFrames = buildWaterAnimFrames(world.sizeX, world.sizeY);
      surfaceScratch = document.createElement("canvas");
      surfaceScratch.width = waterAnimFrames[0].width;
      surfaceScratch.height = waterAnimFrames[0].height;
      surfaceScratchCtx = surfaceScratch.getContext("2d");
    }
  }

  /**
   * 128x128 ワールドをビューポート・ソース矩形クリッピング付きで高速描画し、描画統計を返す。
   */
  function renderVoxelWorld(ctx, world, player, cam, settings, timeSec) {
    const t0 = performance.now();
    ensureWaterAnimResources(world);

    const viewW = ctx.canvas.width;
    const viewH = ctx.canvas.height;

    const pitchRad = (cam.pitchDeg * Math.PI) / 180;
    const squashY = Math.sin(pitchRad);
    // 1ブロック = BLOCK_SIZE(6) x BLOCK_SLICES(8) なので、縦横比 6/8 を掛けて厳密な 1:1:1 立方体にする
    const sliceUnitScale = BLOCK_SIZE / BLOCK_SLICES;
    const liftPerSlice = Math.cos(pitchRad) * cam.zoom * sliceUnitScale * settings.sliceSpacingMult;
    const blockScreenPx = BLOCK_SIZE * cam.zoom;

    const worldSlices = world.getSlices(settings.useAO, settings.useEdgeHighlight);
    const animFrame = Math.floor(timeSec * 3.6) % waterAnimFrames.length;
    const animTex = waterAnimFrames[animFrame];

    let playerSlices = PLAYER_POSES.idle;
    if (player.isMoving && player.onGround) {
      const cycle = Math.floor(player.walkCycle * 7) % 4;
      if (cycle === 1) playerSlices = PLAYER_POSES.stepA;
      else if (cycle === 3) playerSlices = PLAYER_POSES.stepB;
    } else if (!player.onGround) {
      playerSlices = PLAYER_POSES.stepA;
    }

    const playerBaseSlice = Math.round(player.z * BLOCK_SLICES);
    const playerMaxSlice = playerBaseSlice + playerSlices.length - 1;

    const floorInfo = world.findFloorBelow(player.x, player.y, player.z + 0.05);
    const shadowSliceZ = Math.round(floorInfo.floorZ * BLOCK_SLICES);

    const fullTopSlice = Math.max(world.maxUsedSlice, playerMaxSlice + 1);
    const limitZ =
      settings.maxVisibleSlice >= world.maxUsedSlice
        ? fullTopSlice
        : settings.maxVisibleSlice;

    const pRelX = (player.x - cam.x) * blockScreenPx;
    const pRelY = (player.y - cam.y) * blockScreenPx;
    const pDrawSize = blockScreenPx * 0.96;

    // 逆投影用の三角関数（画面4隅を各スライス平面へ逆変換して描画領域をクロップする）
    const cosNeg = Math.cos(-cam.yaw);
    const sinNeg = Math.sin(-cam.yaw);
    const invBlockPx = 1 / blockScreenPx;
    const invSquashY = 1 / squashY;

    // 統計カウンタ
    let worldDrawCalls = 0;
    let waterDrawCalls = 0;
    let miscDrawCalls = 0;
    let drawnSlices = 0;
    let culledSlices = 0;
    let cropAreaSum = 0;
    let cropSamples = 0;

    ctx.imageSmoothingEnabled = !settings.pixelated;

    const camBaseSlice = cam.z * BLOCK_SLICES;
    const worldArea = world.sizeX * world.sizeY;

    for (let sliceZ = 0; sliceZ < limitZ; sliceZ++) {
      const wSlice = sliceZ < worldSlices.length ? worldSlices[sliceZ] : null;
      const hasWaterBody = sliceZ < world.totalSlices && world.waterSliceHasBody[sliceZ] === 1;
      const hasWaterSurf = sliceZ < world.totalSlices && world.waterSliceHasSurface[sliceZ] === 1;
      const hasShadow = sliceZ === shadowSliceZ && floorInfo.floorZ > 0;
      const hasPlayer = sliceZ >= playerBaseSlice && sliceZ <= playerMaxSlice;

      if (!wSlice && !hasWaterBody && !hasWaterSurf && !hasShadow && !hasPlayer) {
        continue;
      }

      const sliceOffsetY = -(sliceZ - camBaseSlice) * liftPerSlice;
      const originScreenY = cam.screenCenterY + sliceOffsetY;

      // 画面4隅をこのスライスのワールドブロック座標へ逆投影して、可視矩形 [minBx..maxBx, minBy..maxBy] を求める
      const dx0 = -cam.screenCenterX;
      const dx1 = viewW - cam.screenCenterX;
      const dy0 = -originScreenY * invSquashY;
      const dy1 = (viewH - originScreenY) * invSquashY;

      const bx0 = cam.x + (dx0 * cosNeg - dy0 * sinNeg) * invBlockPx;
      const by0 = cam.y + (dx0 * sinNeg + dy0 * cosNeg) * invBlockPx;
      const bx1 = cam.x + (dx1 * cosNeg - dy0 * sinNeg) * invBlockPx;
      const by1 = cam.y + (dx1 * sinNeg + dy0 * cosNeg) * invBlockPx;
      const bx2 = cam.x + (dx0 * cosNeg - dy1 * sinNeg) * invBlockPx;
      const by2 = cam.y + (dx0 * sinNeg + dy1 * cosNeg) * invBlockPx;
      const bx3 = cam.x + (dx1 * cosNeg - dy1 * sinNeg) * invBlockPx;
      const by3 = cam.y + (dx1 * sinNeg + dy1 * cosNeg) * invBlockPx;

      const minBx = Math.max(0, Math.floor(Math.min(bx0, bx1, bx2, bx3)) - 1);
      const maxBx = Math.min(world.sizeX, Math.ceil(Math.max(bx0, bx1, bx2, bx3)) + 1);
      const minBy = Math.max(0, Math.floor(Math.min(by0, by1, by2, by3)) - 1);
      const maxBy = Math.min(world.sizeY, Math.ceil(Math.max(by0, by1, by2, by3)) + 1);

      const cropW = maxBx - minBx;
      const cropH = maxBy - minBy;
      const inFrustum = cropW > 0 && cropH > 0;

      if (!inFrustum && !hasPlayer && !hasShadow) {
        culledSlices++;
        continue;
      }

      drawnSlices++;
      if (inFrustum) {
        cropAreaSum += (cropW * cropH) / worldArea;
        cropSamples++;
      }

      const dstX = (minBx - cam.x) * blockScreenPx;
      const dstY = (minBy - cam.y) * blockScreenPx;
      const dstW = cropW * blockScreenPx;
      const dstH = cropH * blockScreenPx;

      ctx.save();
      ctx.translate(cam.screenCenterX, originScreenY);
      ctx.scale(1, squashY);
      ctx.rotate(cam.yaw);

      // 1. 固体ワールド断面（可視領域のみソース矩形クロップして drawImage）
      if (wSlice && inFrustum) {
        ctx.drawImage(
          wSlice,
          minBx * BLOCK_SIZE,
          minBy * BLOCK_SIZE,
          cropW * BLOCK_SIZE,
          cropH * BLOCK_SIZE,
          dstX,
          dstY,
          dstW,
          dstH
        );
        worldDrawCalls++;

        if (settings.showWireframe && sliceZ % BLOCK_SLICES === 0) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
          ctx.lineWidth = 1.1;
          ctx.strokeRect(
            -cam.x * blockScreenPx,
            -cam.y * blockScreenPx,
            world.sizeX * blockScreenPx,
            world.sizeY * blockScreenPx
          );
          miscDrawCalls++;
        }
      }

      // 2. プレイヤーの接地影
      if (hasShadow) {
        const heightAboveFloor = Math.max(0, player.z - floorInfo.floorZ);
        const shadowScale = Math.max(0.45, 1 - heightAboveFloor * 0.22);
        ctx.save();
        ctx.translate(pRelX, pRelY);
        ctx.fillStyle = `rgba(10, 20, 14, ${0.34 * shadowScale})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, pDrawSize * 0.36 * shadowScale, pDrawSize * 0.36 * shadowScale, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        miscDrawCalls++;
      }

      // 3. プレイヤーの断面
      if (hasPlayer) {
        const pLocalZ = sliceZ - playerBaseSlice;
        const pSliceCanvas = playerSlices[pLocalZ];
        ctx.save();
        ctx.translate(pRelX, pRelY);
        ctx.rotate(player.facing);
        ctx.drawImage(pSliceCanvas, -pDrawSize / 2, -pDrawSize / 2, pDrawSize, pDrawSize);
        miscDrawCalls++;

        if (settings.showWireframe && pLocalZ % 3 === 0) {
          ctx.strokeStyle = "rgba(251, 191, 36, 0.7)";
          ctx.lineWidth = 1;
          ctx.strokeRect(-pDrawSize / 2, -pDrawSize / 2, pDrawSize, pDrawSize);
          miscDrawCalls++;
        }
        ctx.restore();
      }

      // 4. 半透明の水体積スライス（可視領域のみクロップ描画）
      if (hasWaterBody && inFrustum) {
        ctx.drawImage(
          world.waterBodySlices[sliceZ],
          minBx,
          minBy,
          cropW,
          cropH,
          dstX,
          dstY,
          dstW,
          dstH
        );
        waterDrawCalls++;
      }

      // 5. 露出水面コースティクス（可視領域だけオフスクリーン合成して高速描画）
      if (hasWaterSurf && inFrustum) {
        const subW = cropW * WATER_PX_PER_BLOCK;
        const subH = cropH * WATER_PX_PER_BLOCK;
        const animSrcX = minBx * WATER_PX_PER_BLOCK;
        const animSrcY = minBy * WATER_PX_PER_BLOCK;

        surfaceScratchCtx.globalCompositeOperation = "copy";
        surfaceScratchCtx.imageSmoothingEnabled = false;
        surfaceScratchCtx.drawImage(
          world.waterSurfaceMasks[sliceZ],
          minBx,
          minBy,
          cropW,
          cropH,
          0,
          0,
          subW,
          subH
        );
        surfaceScratchCtx.globalCompositeOperation = "source-in";
        surfaceScratchCtx.drawImage(animTex, animSrcX, animSrcY, subW, subH, 0, 0, subW, subH);

        ctx.drawImage(surfaceScratch, 0, 0, subW, subH, dstX, dstY, dstW, dstH);
        waterDrawCalls += 3; // オフスクリーン合成2回 + 本描画1回
      }

      ctx.restore();
    }

    return {
      renderMs: performance.now() - t0,
      worldDrawCalls,
      waterDrawCalls,
      miscDrawCalls,
      totalDrawCalls: worldDrawCalls + waterDrawCalls + miscDrawCalls,
      drawnSlices,
      culledSlices,
      totalSlices: world.maxUsedSlice,
      cropRatio: cropSamples > 0 ? cropAreaSum / cropSamples : 0,
    };
  }

  /**
   * 右側観察パネル用：単体モデルのスタッキング描画
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
  global.VoxelWalk.renderVoxelWorld = renderVoxelWorld;
  global.VoxelWalk.drawSingleModelPreview = drawSingleModelPreview;
})(window);
