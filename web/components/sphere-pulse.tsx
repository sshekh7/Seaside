"use client"

import { useEffect, useRef } from "react"

export function SpherePulse({ label }: { label?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    const THREE = require("three")
    const canvas = canvasRef.current
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
    camera.position.z = 3
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setSize(160, 160)
    renderer.setPixelRatio(2)

    const geo = new THREE.SphereGeometry(1, 64, 64)
    const positions = geo.attributes.position
    const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.015, sizeAttenuation: true })
    const points = new THREE.Points(geo, mat)
    scene.add(points)

    const basePositions = Float32Array.from(positions.array)
    let t = 0
    let raf = 0
    const animate = () => {
      t += 0.012
      const pulse = 1 + Math.sin(t * 1.2) * 0.15
      const arr = positions.array as Float32Array
      for (let i = 0; i < arr.length; i += 3) {
        const bx = basePositions[i], by = basePositions[i + 1], bz = basePositions[i + 2]
        const n1 = Math.sin(bx * 8 + t * 2) * Math.cos(by * 6 + t * 1.5) * Math.sin(bz * 7 + t * 1.8)
        const n2 = Math.sin(bx * 12 + t * 3) * Math.sin(bz * 10 - t * 2)
        const spike = Math.max(0, n1 * 0.4 + n2 * 0.2)
        const scale = pulse + spike
        arr[i] = bx * scale
        arr[i + 1] = by * scale
        arr[i + 2] = bz * scale
      }
      positions.needsUpdate = true
      points.rotation.y = t * 0.3
      points.rotation.x = Math.sin(t * 0.15) * 0.15
      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }
    animate()
    return () => { cancelAnimationFrame(raf); renderer.dispose() }
  }, [])

  return (
    <div className="flex flex-col items-center gap-4">
      <canvas ref={canvasRef} className="size-40" />
      {label && <p className="text-sm text-muted-foreground animate-pulse">{label}</p>}
    </div>
  )
}
