# jojos-karaoke maker

`jojo make song.mp3` → `song.jkp` (instrumental, vocal stem, word-timed lyrics, pitch).

```bash
uv tool install 'jojos-karaoke[ml]'      # or [gpu] on an NVIDIA machine
jojo doctor                              # checks ffmpeg, GPU, models, login
jojo make song.mp3                       # lyrics: looked up on LRCLIB, else transcribed
jojo make song.mp3 --lyrics song.txt     # or .lrc
jojo make song.mp3 --video               # also an MP4 with the word wipe
jojo login && jojo make song.mp3 --upload
jojo worker --room K7Q2                  # process on-the-spot requests for a party
```

See the repository README for installing on Windows/macOS/Linux.
