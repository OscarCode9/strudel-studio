export const CHANNEL_PALETTE = [
  '#ff7a59', // coral kick
  '#f5b041', // amber bass
  '#4dd0e1', // cyan hats
  '#f06292', // rose clap
  '#ba68c8', // violet perc
  '#26c6da', // teal arp
  '#ff934f', // fl orange lead
  '#9575cd', // indigo eco
  '#7cd67b', // mint chords
  '#ffd54f', // gold keys
  '#ec407a', // magenta vocal
  '#64b5f6', // sky extra
];

export const starterProjectSource = `// @title Beat Nuevo (Base FL Studio)
const bpm = 132
setcpm(bpm / 4)

const kick = s("bd*4").gain(.95)
const clap = s("~ cp ~ cp").room(.18).gain(.72)
const hats = s("[~ hh]*4").hpf(5500).gain(.45)
const bajo = note("<[b1 ~ b1 ~ b1 ~ d2 ~] [g1 ~ g1 ~ g1 ~ a1 ~] [e1 ~ e1 ~ e1 ~ g1 ~] [f#1 ~ f#1 ~ a1 ~ f#1 ~]>")
  .s("sawtooth").lpf(420).attack(.005).decay(.14).sustain(.4).gain(.65)
const acordes = note("<[b3,d4,f#4] [g3,b3,d4] [e3,g3,b3] [f#3,a3,c#4]>")
  .s("supersaw").lpf(1800).attack(.04).decay(.3).sustain(.5).room(.28).gain(.32)
const lead = note("<[b4@2 d5@2 f#5@2 ~@2 b5@2 a5@2 f#5@4] [g4@2 b4@2 d5@2 ~@2 g5@2 f#5@2 d5@4]>")
  .s("sawtooth").lpf(4200).attack(.01).decay(.15).sustain(.45).delay(.22).gain(.46)

const intro = stack(kick, hats, acordes)
const drop = stack(kick, clap, hats, bajo, acordes, lead)

const arreglo = arrange(
  [4, intro],
  [8, drop],
  [4, stack(clap, acordes, lead)],
  [8, drop]
).postgain(.9)

arreglo`;
