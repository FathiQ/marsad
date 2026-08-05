"""Rebuild the observatory mark as vector geometry traced from the source render.

The source is a raster whose shells are separated by soft grooves in a lighter
navy. A logo has to survive being filled in one flat colour, so those grooves
become real transparent gaps and the two shell tones collapse to one.

The dome is cut by a single groove that runs off its upper right and forks on
the way down — the open shutter. That yields three shells: the large left one,
the middle one the sky shows through, and the right crescent. Curves are
measured off the source render; corners between them are emitted as
straight segments so the smoothing never rounds a join that should stay sharp.
"""
import json

CX, FOOT = 32.05, 37.30
BASE_TOP, BASE_BOT, HW = 38.55, 52.40, 25.96
GROOVE = 0.62          # measured ridge width -> the line the eye actually reads

DOME = [(10.80,0.00),(11.35,4.57),(12.08,6.95),(12.81,9.14),(13.54,10.97),
        (14.28,12.61),(15.01,13.98),(15.74,14.81),(16.47,15.81),(17.20,16.70),
        (17.93,17.55),(18.66,18.30),(19.39,19.01),(20.12,19.70),(20.85,20.29),
        (21.58,20.85),(22.31,21.39),(23.04,21.86),(23.77,22.30),(25.24,23.12),
        (26.70,23.86),(28.16,24.40),(29.62,24.86),(31.08,25.23),(32.54,25.50),
        (34.00,25.78),(35.46,25.96),(37.30,25.96)]

G1 = [(12.90,47.4,4.60),(13.60,45.5,4.50),(15.55,39.9,4.07),(17.38,36.5,3.34),
      (19.20,34.0,2.92),(21.03,32.1,2.70),(22.86,30.4,2.47),(24.69,28.9,2.29),
      (26.51,27.8,2.15),(28.34,26.8,2.10),(30.17,26.0,2.01),(32.00,25.3,1.87),
      (33.82,24.7,1.74),(37.30,23.4,1.60)]
FORK = 18.30
G2 = [(19.20,40.7,1.19),(21.03,42.2,2.20),(22.86,44.8,2.38),(24.69,46.9,2.10),
      (26.51,48.6,1.97),(28.34,50.0,1.87),(30.17,51.1,1.74),(32.00,51.9,1.69),
      (33.82,52.7,1.55),(35.65,53.3,1.52),(37.30,53.9,1.50)]
SKY_L = [(25.30,33.5),(26.51,31.9),(29.30,30.3),(32.00,29.1),(34.70,28.2),(37.30,27.7)]
SKY_R = [(25.30,33.5),(26.51,36.5),(29.30,39.2),(32.00,40.8),(34.70,41.9),(37.30,42.3)]

def interp(table, y):
    if y <= table[0][0]: return table[0][1:]
    if y >= table[-1][0]: return table[-1][1:]
    for (y0,*a),(y1,*b) in zip(table, table[1:]):
        if y0 <= y <= y1:
            t = (y-y0)/(y1-y0)
            return tuple(u+(v-u)*t for u,v in zip(a,b))

def out(y, side): return CX + side*interp(DOME, y)[0]
def g1(y, side):
    m,w = interp(G1, y); return m + side*w*GROOVE
def g2(y, side):
    """The second groove branches off the first, so it opens from a point."""
    if y <= FORK: return g1(FORK, 1)
    if y <= G2[0][0]:
        t = (y-FORK)/(G2[0][0]-FORK)
        m1, w1 = G2[0][1], G2[0][2]*GROOVE
        return g1(FORK,1)*(1-t) + m1*t + side*w1*t
    m,w = interp(G2, y); return m + side*w*GROOVE

def cross(f, lo, hi):
    """Where a groove edge leaves the dome outline."""
    for _ in range(60):
        mid = (lo+hi)/2
        if (f(lo)-out(lo,1))*(f(mid)-out(mid,1)) <= 0: hi = mid
        else: lo = mid
    return (lo+hi)/2

Y_A = cross(lambda y: g1(y,-1), 12.9, 16.5)
Y_C = cross(lambda y: g1(y, 1), 13.5, 17.5)

def walk(f, y0, y1, n=26):
    return [(f(y0+(y1-y0)*i/n), y0+(y1-y0)*i/n) for i in range(n+1)]

def flank(side, y0, y1):
    """The dome outline between two heights, apex included when it is crossed."""
    pts = [(CX+side*hw, y) for y,hw in DOME if min(y0,y1) <= y <= max(y0,y1)]
    return pts if y1 > y0 else pts[::-1]

def bezier(pts, first):
    """Catmull-Rom through pts with clamped ends, so joins stay where put."""
    pts = [p for i,p in enumerate(pts)
           if i == 0 or abs(p[0]-pts[i-1][0]) + abs(p[1]-pts[i-1][1]) > 0.02]
    ext = [pts[0]] + pts + [pts[-1]]
    d = f"M{pts[0][0]:.2f},{pts[0][1]:.2f}" if first else ""
    for i in range(1, len(ext)-2):
        p0,p1,p2,p3 = ext[i-1:i+3]
        c1 = (p1[0]+(p2[0]-p0[0])/6, p1[1]+(p2[1]-p0[1])/6)
        c2 = (p2[0]-(p3[0]-p1[0])/6, p2[1]-(p3[1]-p1[1])/6)
        d += f"C{c1[0]:.2f},{c1[1]:.2f} {c2[0]:.2f},{c2[1]:.2f} {p2[0]:.2f},{p2[1]:.2f}"
    return d

def thin(pts, n):
    if len(pts) <= n: return pts
    run = [0.0]
    for a,b in zip(pts, pts[1:]): run.append(run[-1]+((b[0]-a[0])**2+(b[1]-a[1])**2)**0.5)
    keep, j = [pts[0]], 0
    for i in range(1, n):
        t = run[-1]*i/(n-1)
        while j < len(run)-1 and run[j] < t: j += 1
        keep.append(pts[j])
    return keep

def path(segments):
    d, first = "", True
    for kind, pts, *n in segments:
        if kind == 'L':
            d += f"L{pts[-1][0]:.2f},{pts[-1][1]:.2f}"
        else:
            d += bezier(thin(pts, n[0]), first)
            first = False
    return d + "Z"

apex_to = lambda side, y: flank(side, 10.80, y)

shells = [
    # Left shell: over the apex, down the left flank, then up the groove.
    path([('C', apex_to(1, Y_A)[::-1] + apex_to(-1, FOOT), 26),
          ('L', [(g1(FOOT,-1), FOOT)]),
          ('C', walk(lambda y: g1(y,-1), FOOT, Y_A), 12)]),
    # Middle shell, below the fork. The sky is a hole in this one.
    path([('C', walk(lambda y: g1(y, 1), FORK, FOOT), 12),
          ('L', [(g2(FOOT,-1), FOOT)]),
          ('C', walk(lambda y: g2(y,-1), FOOT, FORK), 12)]),
    # Right crescent, between the second groove and the dome's right flank.
    path([('C', flank(1, Y_C, FOOT), 14),
          ('L', [(g2(FOOT, 1), FOOT)]),
          ('C', walk(lambda y: g2(y, 1), FOOT, FORK), 10),
          ('C', walk(lambda y: g1(y, 1), FORK, Y_C), 8)]),
]
sky = path([('C', walk(lambda y: interp(SKY_R,y)[0], 25.30, FOOT), 10),
            ('L', [(interp(SKY_L,FOOT)[0], FOOT)]),
            ('C', walk(lambda y: interp(SKY_L,y)[0], FOOT, 25.30), 10)])
r = 1.2
base = (f"M{CX-HW+r:.2f},{BASE_TOP:.2f} H{CX+HW-r:.2f} A{r},{r} 0 0 1 {CX+HW:.2f},{BASE_TOP+r:.2f} "
        f"V{BASE_BOT-r:.2f} A{r},{r} 0 0 1 {CX+HW-r:.2f},{BASE_BOT:.2f} H{CX-HW+r:.2f} "
        f"A{r},{r} 0 0 1 {CX-HW:.2f},{BASE_BOT-r:.2f} V{BASE_TOP+r:.2f} "
        f"A{r},{r} 0 0 1 {CX-HW+r:.2f},{BASE_TOP:.2f} Z")

print(f"breach {Y_A:.2f}  crescent {Y_C:.2f}  path chars {[len(s) for s in shells]}")
# The sky rides along as a hole in the shell, so a flat one-colour fill still
# shows the opening instead of collapsing the mark to a plain dome.
shell_d = " ".join(shells + [base, sky])
open('parts.json','w').write(json.dumps({'shell': shell_d, 'sky': sky}))

PLAIN = ('<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">'
         '<path fill="{s}" fill-rule="evenodd" d="{d}"/><path fill="{k}" d="{sd}"/></svg>')
MONO = ('<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">'
        '<path fill="{s}" fill-rule="evenodd" d="{d}"/></svg>')
TILE = ('<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">'
        '<rect width="64" height="64" rx="13" fill="#0F1622"/>'
        '<g transform="translate(32,32.6) scale(0.88) translate(-32.05,-31.6)">'
        '<path fill="#E8EEF7" fill-rule="evenodd" d="{d}"/>'
        '<path fill="#41B2FE" d="{sd}"/></g></svg>')
open('mark.svg','w').write(PLAIN.format(s='#E8EEF7', k='#41B2FE', d=shell_d, sd=sky))
open('mark-onlight.svg','w').write(PLAIN.format(s='#1A202B', k='#2F87D8', d=shell_d, sd=sky))
open('mark-mono.svg','w').write(MONO.format(s='#E8EEF7', d=shell_d))
open('favicon.svg','w').write(TILE.format(d=shell_d, sd=sky))
print('wrote mark.svg mark-onlight.svg mark-mono.svg favicon.svg')
print('the favicon wants GROOVE = 1.05; the app mark wants 0.62')
