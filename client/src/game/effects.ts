// Floating world-space text popups (+$20, SALE, etc.).
import * as THREE from 'three';

interface Popup {
  sprite: THREE.Sprite;
  age: number;
  life: number;
}

export class Effects {
  private popups: Popup[] = [];

  constructor(private scene: THREE.Scene) {}

  popupText(pos: THREE.Vector3, text: string, color = '#7dff8a'): void {
    if (this.popups.length > 24) return; // pool cap
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const g = canvas.getContext('2d')!;
    g.font = 'bold 52px system-ui, sans-serif';
    g.textAlign = 'center';
    g.lineWidth = 8;
    g.strokeStyle = 'rgba(20,30,20,0.85)';
    g.strokeText(text, 128, 62);
    g.fillStyle = color;
    g.fillText(text, 128, 62);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
    );
    sprite.position.copy(pos);
    sprite.scale.set(6, 2.25, 1);
    this.scene.add(sprite);
    this.popups.push({ sprite, age: 0, life: 1.6 });
  }

  update(dt: number): void {
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.age += dt;
      p.sprite.position.y += dt * 2.2;
      const t = p.age / p.life;
      (p.sprite.material as THREE.SpriteMaterial).opacity = 1 - t * t;
      if (p.age >= p.life) {
        this.scene.remove(p.sprite);
        (p.sprite.material as THREE.SpriteMaterial).map?.dispose();
        p.sprite.material.dispose();
        this.popups.splice(i, 1);
      }
    }
  }
}
