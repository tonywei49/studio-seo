import { useEffect, useRef } from 'react'

type MatrixRainProps = {
  mode: 'normal' | 'brutal'
}

export function MatrixRain({ mode }: MatrixRainProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const context = canvas.getContext('2d')
    if (!context) {
      return
    }

    const chars = mode === 'brutal' ? '01SEOALERT火刃裂变' : '01SEOAIMATRIX搜索引流'
    let animationFrame = 0
    let lastFrame = 0
    let width = window.innerWidth
    let height = window.innerHeight
    let fontSize = 16
    let columns = Math.floor(width / fontSize)
    let drops = Array.from({ length: columns }, () => Math.random() * height)

    const resize = () => {
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = width
      canvas.height = height
      fontSize = width < 720 ? 12 : 16
      columns = Math.floor(width / fontSize)
      drops = Array.from({ length: columns }, () => Math.random() * height)
    }

    const draw = (timestamp: number) => {
      if (timestamp - lastFrame < 70) {
        animationFrame = window.requestAnimationFrame(draw)
        return
      }
      lastFrame = timestamp

      const fade = mode === 'brutal' ? 'rgba(8, 0, 0, 0.14)' : 'rgba(1, 7, 4, 0.12)'
      const glow = mode === 'brutal' ? 'rgba(255, 65, 65, 0.78)' : 'rgba(99, 255, 180, 0.72)'
      const tail = mode === 'brutal' ? '#ff3d3d' : '#76ffb3'
      const spark = mode === 'brutal' ? 'rgba(255, 218, 218, 0.92)' : 'rgba(226, 255, 242, 0.92)'

      context.fillStyle = fade
      context.fillRect(0, 0, width, height)
      context.font = `${fontSize}px monospace`
      context.shadowBlur = 12
      context.shadowColor = glow

      for (let index = 0; index < drops.length; index += 1) {
        const char = chars[Math.floor(Math.random() * chars.length)]
        const x = index * fontSize
        const y = drops[index]
        const sparkle = Math.random() > 0.985
        context.fillStyle = sparkle ? spark : glow
        context.fillText(char, x, y)
        context.fillStyle = tail
        context.fillText(char, x, y - fontSize * 0.35)
        if (sparkle) {
          context.shadowBlur = 26
          context.fillRect(x - 1, y - fontSize * 0.9, 2, fontSize * 0.7)
          context.shadowBlur = 12
        }

        drops[index] =
          y > height + Math.random() * 400
            ? 0
            : y + fontSize * (0.32 + Math.random() * 0.48)
      }

      context.shadowBlur = 0
      animationFrame = window.requestAnimationFrame(draw)
    }

    resize()
    draw(0)
    window.addEventListener('resize', resize)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', resize)
    }
  }, [mode])

  return <canvas className="matrix-rain" ref={canvasRef} />
}
