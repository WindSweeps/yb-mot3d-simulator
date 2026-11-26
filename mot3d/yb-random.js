const rotations = [13,15,26,6,17,29,16,24];
const scale = 1 / 4294967296;

// Random123 Threefry2x32/20。输出用开区间转换，指数等待时间可直接取对数。
export function threefry2x32(counter0, counter1, key0, key1, output = new Uint32Array(2)) {
  const parity = 0x1bd11bda ^ key0 ^ key1;
  let left = (counter0 + key0) | 0, right = (counter1 + key1) | 0;
  for (let round = 0; round < 20; round++) {
    const rotation = rotations[round & 7];
    left = (left + right) | 0;
    right = ((right << rotation) | (right >>> (32-rotation))) ^ left;
    switch (round) {
      case 3: left = (left+key1)|0; right = (right+parity+1)|0; break;
      case 7: left = (left+parity)|0; right = (right+key0+2)|0; break;
      case 11: left = (left+key0)|0; right = (right+key1+3)|0; break;
      case 15: left = (left+key1)|0; right = (right+parity+4)|0; break;
      case 19: left = (left+parity)|0; right = (right+key0+5)|0; break;
    }
  }
  output[0] = left;
  output[1] = right;
  return output;
}

export const randomChannel = Object.freeze({source:0, blueRecoil:1, greenJump:2, cascade:3, repump:4, spin:5});

export function atomRandom(seed, id, branch) {
  const counters = new Uint32Array(6), spare = new Uint32Array(6), words = new Uint32Array(2);
  const stream = id*16+branch;
  let step, region;
  function uniform(channel) {
    const draw = counters[channel]++;
    if (draw & 1) return (spare[channel]+.5) * scale;
    if (draw >= 2**25) throw new RangeError('单步随机事件数超出计数器范围。');
    threefry2x32(step, (region << 28) | (channel << 24) | (draw >>> 1), seed, stream, words);
    spare[channel] = words[1];
    return (words[0]+.5) * scale;
  }
  return {
    reset(stage, index) {
      if (index >= 2**32) throw new RangeError('时序步数超出随机计数器范围。');
      region = stage;
      step = index;
      counters.fill(0);
    },
    uniform,
    exponential(channel) { return -Math.log(uniform(channel)); },
    normals(channel, out) {
      for (let i = 0; i < out.length; i += 2) {
        const radius = Math.sqrt(-2*Math.log(uniform(channel)));
        const phi = 2*Math.PI*uniform(channel);
        out[i] = radius*Math.cos(phi);
        if (i+1 < out.length) out[i+1] = radius*Math.sin(phi);
      }
    },
  };
}
