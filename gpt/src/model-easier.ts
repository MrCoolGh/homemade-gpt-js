/**
 * Full definition of a GPT Language Model, all of it in this single file.
 *
 * This is a tensorflow.js version of pytorch-based minGPT from Andrej Karpathy:
 * - https://github.com/karpathy/ng-video-lecture
 * - https://github.com/karpathy/nanoGPT
 * - https://github.com/karpathy/minGPT
 *
 * To understand what's going on here please check this detailed and nicely explained lecture from Andrej Karpathy:
 * - https://www.youtube.com/watch?v=kCc8FmEb1nY
 *
 * This is a simplified (but slower) version of the model from the ./model.ts file.
 * - It processes all `Heads` inside `CausalSelfAttention` sequentially (instead of in parallel).
 * - It lacks the `disposal()` and tf.tidy() calls so it contains memory-leaks (!).
 * - It doesn't have initial initializers for some dense and norm layers.
 */
import * as tf from '@tensorflow/tfjs'
import { Layer, Model, ModelParams, OptimizerParams } from './types'
import { countParams, dispose, withLayerHelpers, withModelHelpers } from './utils'

// GPT Language Model
export function GPT(params: ModelParams): Model {
  const { nLayer, nHead, nEmbd, vocabSize, blockSize, embdDropout = 0.1, residDropout = 0.1, attnDropout = 0.1 } = params

  let modelIsWarm = false // Whether model weights are initialized yet or not

  const transformer = {
    wte: tf.layers.embedding({ name: 'wte', inputDim: vocabSize + 1, outputDim: nEmbd, maskZero: true }), // Weight token embedding (with 0 as a mask)
    wpe: tf.layers.embedding({ name: 'wpe', inputDim: blockSize, outputDim: nEmbd, inputShape: [blockSize] }), // Weight position embedding
    drop: tf.layers.dropout({ name: 'drop', rate: embdDropout }),
    add: tf.layers.add({ name: 'add' }), // It will add token and position embeddings
    h: Array.from({ length: nLayer }, (_, i) => Block({ nEmbd, nHead, blockSize, attnDropout, residDropout, nLayer, name: `block${i + 1}` })), // Blocks
    lnF: tf.layers.layerNormalization({ name: 'lnF' }), // Final normalization layer
  }
  const lmHead = tf.layers.dense({ name: 'lmHead', units: vocabSize, useBias: false })

  const model: Model = {
    params,
    apply: (idx: tf.Tensor): tf.Tensor => tf.tidy(() => {
      const [B, T] = idx.shape // B - batch size, T - time dimension (block size)
      if (T !== blockSize) throw new Error(`Sequence must be of size ${blockSize}, got ${T}`)

      const tokEmb = transformer.wte.apply(idx) as tf.SymbolicTensor

      const pos = tf.range(0, T, 1).reshape([1, T]) // Expand dims to match shape [1, T]
      const posBatched = pos.tile([B, 1]) // Repeat position indices for every item in a batch
      const posEmb = transformer.wpe.apply(posBatched) as tf.SymbolicTensor

      let x = transformer.add.apply([tokEmb, posEmb]) as tf.Tensor
      x = transformer.drop.apply(x) as tf.Tensor
      transformer.h.forEach((block) => {
        x = block.apply(x)
      })
      x = transformer.lnF.apply(x) as tf.Tensor

      // Unnormalized outputs of a model's last linear layer before applying an activation function like Softmax
      const logits = lmHead.apply(x)
      return logits as tf.Tensor
    }),

    loss: (idx, targets) => tf.tidy(() => {
      const logits = model.apply(idx)

      const [B, T, C] = logits.shape // B - batch dimension, T - time dimension, C - embeddings dimension
      const flattenLogits = logits.reshape([B * T, C])
      const flattenTargets = targets.reshape([B * T])
      const targetsOneHot = tf.oneHot(flattenTargets, vocabSize)

      const loss = tf.losses.softmaxCrossEntropy(targetsOneHot, flattenLogits)
      return loss
    }),

    // Take a sequence of indices idx (tensor of shape (B, T), with 0 as a mask) and complete the
    // sequence maxNewTokens times, feeding the predictions back into the model each time
    generate: async (params, onGenerateChar) => {
      const { maxNewTokens, temperature = 1.0, doSample = false, topK } = params
      let { idx } = params

      for (let i = 0; i < maxNewTokens; i++) {
        const T = idx.shape[1]!

        const idxShaped = tf.concat(
          [
            // If idx is too long - truncate the beginning of time dimension and keep the end
            idx.slice([0, Math.max(0, T - blockSize)], [-1, Math.min(T, blockSize)]),
            // If idx is too short - pad the time dimension with -1 (keep the beginning)
            tf.zeros([idx.shape[0], Math.max(0, blockSize - T)], 'int32'),
          ],
          1,
        )

        // Forward the model to get the logits for the index in the sequence
        const logits = model.apply(idxShaped) // (B,T,C)

        // Focus only on the last time step (all from first axis, last from second axis, all from third axis)
        // Remove the second axis dimension (because it is 1 after the slice) using tf.squeeze()
        let lastCharLogits = logits.slice([0, i < blockSize ? i : blockSize - 1, 0], [-1, 1, -1]).squeeze([1]) // Becomes (B, C)

        // Scale by desired temperature
        lastCharLogits = tf.div(lastCharLogits, tf.scalar(temperature))

        if (topK) {
          const { values } = lastCharLogits.topk(Math.min(topK, vocabSize))
          const smallestTopK = values.slice([0, values.shape[1]! - 1]) // Last element in the array, since topk sorts the values
          lastCharLogits = lastCharLogits.where(lastCharLogits.greaterEqual(smallestTopK), tf.scalar(-Infinity))
        }

        // Apply softmax to convert logits to (normalized) probabilities
        const probs = tf.softmax(lastCharLogits) as tf.Tensor2D // (B, C)

        let idxNext: tf.Tensor
        let idxNextSliced: tf.Tensor | null = null
        let sampled: tf.Tensor | null = null

        // Either sample from the distribution or take the most likely element
        if (doSample) {
          const backend = tf.getBackend()
          if (backend === 'webgpu') {
            // 1st sample from tf.multinomial is always zero in webgpu backend
            // @see: https://github.com/tensorflow/tfjs/issues/8057
            sampled = tf.multinomial(probs, 2, undefined, true)
            idxNextSliced = sampled.slice([0, 1], [1, 1]) // (B, 1)
            idxNext = idxNextSliced
          } else if (backend === 'tensorflow') {
            // TF Node backend does not support normalized logits passed to multinomial
            sampled = tf.multinomial(lastCharLogits as tf.Tensor2D, 1) // (B, 1)
            idxNext = sampled
          } else {
            sampled = tf.multinomial(probs, 1, undefined, true) // (B, 1)
            idxNext = sampled
          }
        } else {
          sampled = probs.argMax(-1).expandDims(-1)
          idxNext = sampled
        }

        // Append sampled index to the running sequence and continue
        const oldIdx = idx
        idx = idx.concat(idxNext, 1) // (B, T+1)

        if (onGenerateChar) {
          const nextToken = ((await idxNext.array()) as number[][])[0][0]
          onGenerateChar(nextToken)
        }

        dispose([idxShaped, logits, lastCharLogits, probs, sampled, idxNextSliced, idxNext, oldIdx])

        // For browsers: unblock the main thread (allow the UI to be re-rendered)
        await tf.nextFrame()
      }
      return idx
    },

    optimizer: (params: OptimizerParams) => {
      return tf.train.adam(params.learningRate)
    },

    build: () => tf.tidy(() => {
      if (modelIsWarm) return
      // Perform a test prediction to build the layers and initialize default weights.
      model.apply(tf.zeros([1, blockSize]))
      modelIsWarm = true
    }),

    summary: () => tf.tidy(() => {
      model.build()
      // Report number of parameters (note we don't count the decoder parameters in lmHead)
      const { wte, wpe, add, drop, lnF, h } = transformer
      const params = countParams([ wte, wpe, add, drop, lnF, ...h ])
      return { params }
    }),
  }

  return withModelHelpers(model, [transformer.wte, transformer.wpe, transformer.add, transformer.drop, transformer.lnF, transformer.h, lmHead])
}

// Transformer block: communication followed by computation
function Block(args: { nEmbd: number; nHead: number; blockSize: number; residDropout: number; attnDropout: number; nLayer: number, name: string }): Layer {
  const { nEmbd, nHead, blockSize, residDropout, attnDropout, name } = args

  const ln1 = tf.layers.layerNormalization({ name: `${name}-ln1` })
  const attn = CausalSelfAttention({ name: `${name}-attn`, nEmbd, blockSize, nHead, residDropout, attnDropout }) // Self-attention head
  const ln2 = tf.layers.layerNormalization({ name: `${name}-ln2`})
  const mlp = FeedForward({ nEmbd, residDropout, name: `${name}-mlp` })

  const block: Layer = {
    apply: (x: tf.Tensor): tf.Tensor => {
      x = x.add(attn.apply(ln1.apply(x) as tf.Tensor))
      x = x.add(mlp.apply(ln2.apply(x) as tf.Tensor))
      return x
    },
  }

  return withLayerHelpers(block, [ln1, attn, ln2, mlp])
}

// A vanilla multi-head masked self-attention layer with a projection at the end.
function CausalSelfAttention(args: { nEmbd: number; blockSize: number; nHead: number; attnDropout: number; residDropout: number, name: string }): Layer {
  const { nHead, blockSize, nEmbd, attnDropout, residDropout, name } = args

  if (nEmbd % nHead !== 0) throw new Error(`Cannot calculate head size: nEmbd % nHead !== 0`)
  const headSize = nEmbd / nHead

  // The key, query, value projections for all heads.
  const heads = Array.from({ length: nHead }, (_, i) => Head({ nEmbd, headSize, blockSize, attnDropout, name: `${name}-head${i}` }))
  // Output projection
  const proj = tf.layers.dense({ name: `${name}-proj`, units: nEmbd })
  // Regularization
  const drop = tf.layers.dropout({ name: `${name}-drop`, rate: residDropout })

  const multiHeadAttention: Layer = {
    apply: (x: tf.Tensor): tf.Tensor => {
      let y = tf.concat(heads.map((head) => head.apply(x)), -1)
      y = proj.apply(y) as tf.Tensor
      return drop.apply(y) as tf.Tensor
    },
  }

  return withLayerHelpers(multiHeadAttention, [...heads, proj, drop])
}

function Head(args: { nEmbd: number; headSize: number; blockSize: number; attnDropout: number, name: string }): Layer {
  const { nEmbd, headSize, blockSize, attnDropout, name } = args

  const key = tf.layers.dense({ name: `${name}-key`, inputDim: nEmbd, units: headSize, useBias: false })
  const query = tf.layers.dense({ name: `${name}-query`, inputDim: nEmbd, units: headSize, useBias: false })
  const value = tf.layers.dense({ name: `${name}-value`, inputDim: nEmbd, units: headSize, useBias: false })
  const drop = tf.layers.dropout({ name: `${name}-drop`, rate: attnDropout })

  // Create a lower triangular matrix (the equivalent of torch.tril)
  const tril = tf.linalg.bandPart(tf.ones([blockSize, blockSize]), -1, 0)

  const head: Layer = {
    apply: (x: tf.Tensor) => {
      // Input of size (time-step, channels)
      // Output of size (time-step, head size)
      const [B, T] = x.shape // (batch_size, block_size, num_embd)
      const k = key.apply(x) as tf.Tensor // (B, T, hs)
      const q = query.apply(x) as tf.Tensor // (B, T, hs)

      // Compute attention scores ("affinities")
      let att = tf.matMul(q, k.transpose([0, 2, 1])).mul(tf.scalar(1 / Math.sqrt(headSize))) // (T, hs) @ (hs, T) -> (T, T)
      att = tf.where(tril.slice([0, 0], [T, T]).equal(0), tf.scalar(-Infinity), att) // (T, T)
      att = tf.softmax(att) // (T, T)
      att = drop.apply(att) as tf.Tensor

      let y = value.apply(x) as tf.Tensor // (T, hs)
      y = tf.matMul(att, y) // (T, T) @ (T, hs) -> (T, hs)
      return y
    },
  }

  return withLayerHelpers(head, [key, query, value, drop, tril])
}

// A simple linear layer followed by a non-linearity
function FeedForward(args: { nEmbd: number; residDropout: number, name: string }): Layer {
  const { nEmbd, residDropout, name } = args

  const cFc = tf.layers.dense({ name: `${name}-cFc`, inputShape: [nEmbd], units: 4 * nEmbd, activation: 'gelu_new' })
  const cProj = tf.layers.dense({ name: `${name}-cProj`, inputShape: [4 * nEmbd], units: nEmbd })
  const drop = tf.layers.dropout({ name: `${name}-drop`, rate: residDropout })

  const ffwd: Layer = {
    apply: (x: tf.Tensor): tf.Tensor => {
      const x1 = cFc.apply(x)
      const x2 = cProj.apply(x1)
      return drop.apply(x2) as tf.Tensor
    },
  }

  return withLayerHelpers(ffwd, [cFc, cProj, drop])
}
