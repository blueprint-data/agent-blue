# Anime.js Claude Skill

A comprehensive Claude Code skill for [Anime.js v4](https://animejs.com/) - a lightweight JavaScript animation library with a simple yet powerful API.

## Installation

### Option 1: Skills CLI

Install using the [skills CLI](https://skills.sh/docs/cli):

```bash
npx skills add bowtiedswan/animejs-skills
```

### Option 2: Curl (one-liner)

Run this in your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/BowTiedSwan/animejs-skills/main/install.sh | bash
```

Auto-detects Claude Code and installs the skill to `~/.claude/skills/animejs/`.

### Option 3: Manual

Copy the `SKILL.md` and `references/` folder to your Claude skills directory:

```bash
mkdir -p ~/.claude/skills/animejs
cp SKILL.md ~/.claude/skills/animejs/
cp -r references ~/.claude/skills/animejs/
```

## What This Skill Provides

This skill equips Claude with deep knowledge of the Anime.js v4 animation library, enabling it to:

- Write correct, idiomatic anime.js code
- Create complex animation timelines and sequences
- Implement scroll-triggered animations
- Build draggable interfaces with spring physics
- Animate SVG paths, shapes, and motion paths
- Split and animate text (characters, words, lines)
- Use advanced staggering techniques
- Integrate properly with React and other frameworks

## Skill Contents

```
animejs-skills/
├── SKILL.md                      # Main skill with overview and quick reference
└── references/
    ├── api-reference.md          # Complete API documentation
    └── examples.md               # Common patterns and code recipes
```

## Documentation Coverage

### Core Animation APIs
| API | Description |
|-----|-------------|
| `animate()` | Animate CSS, transforms, SVG, objects |
| `createTimeline()` | Sequence multiple animations |
| `createTimer()` | Synchronized timing callbacks |
| `stagger()` | Distribute values across targets |

### Advanced Features
| API | Description |
|-----|-------------|
| `createDraggable()` | Drag & drop with physics |
| `onScroll()` | Scroll-triggered animations |
| `createLayout()` | Auto layout animations (FLIP) |
| `createScope()` | React integration & media queries |
| `createAnimatable()` | Reactive property animations |

### SVG Utilities
| API | Description |
|-----|-------------|
| `morphTo()` | Shape morphing between paths |
| `createDrawable()` | SVG line drawing animation |
| `createMotionPath()` | Animate along SVG paths |

### Text Utilities
| API | Description |
|-----|-------------|
| `splitText()` | Split text into chars/words/lines |

### Easings
- **Built-in**: linear, quad, cubic, quart, quint, sine, expo, circ, back, elastic, bounce (in/out/inOut variants)
- **Custom**: Cubic Bezier, Steps, Linear (multi-point), Irregular
- **Physics**: `createSpring()` for spring-based animations

### Utilities
- DOM helpers: `$()`, `get()`, `set()`, `remove()`, `cleanInlineStyles()`
- Math: `random()`, `clamp()`, `snap()`, `wrap()`, `lerp()`, `mapRange()`, `damp()`
- Conversion: `degToRad()`, `radToDeg()`
- Engine configuration and defaults

## Trigger Phrases

This skill activates when you mention:
- "anime.js", "animejs"
- "animate elements", "CSS animation with JS"
- "timeline animation", "stagger animation"
- "SVG morphing", "motion path", "line drawing"
- "scroll animation", "scroll-triggered"
- "draggable", "drag and drop"
- "spring animation", "keyframe animation"

## Quick Examples

### Basic Animation
```javascript
import { animate } from 'animejs';

animate('.element', {
  translateX: 250,
  rotate: '1turn',
  duration: 800,
  ease: 'outExpo'
});
```

### Timeline Sequence
```javascript
import { createTimeline } from 'animejs';

createTimeline()
  .add('.box-1', { x: 100 })
  .add('.box-2', { x: 100 }, '<')  // Start with previous
  .add('.box-3', { x: 100 }, '-=200');
```

### Staggered Animation
```javascript
import { animate, stagger } from 'animejs';

animate('.item', {
  translateY: [-20, 0],
  opacity: [0, 1],
  delay: stagger(100, { from: 'center' })
});
```

### Scroll Animation
```javascript
import { animate, onScroll } from 'animejs';

animate('.element', {
  translateX: [0, 500],
  autoplay: onScroll({ target: '.element', sync: true })
});
```

## Resources

- [Official Documentation](https://animejs.com/documentation)
- [Easing Editor](https://animejs.com/easing-editor)
- [CodePen Examples](https://codepen.io/collection/Poerqa)
- [GitHub Repository](https://github.com/juliangarnier/anime)

## License

MIT
