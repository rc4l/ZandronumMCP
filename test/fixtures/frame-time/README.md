# frame-time fixture

A plain directory for `-file` that warps `FLOOR0_1`, so a held view shows whether the frame-time
hold (`freeze_time` `frameTime`, PROTOCOL "frame-time hold") stops surface animation.

Live check: launch DOOM2 MAP01 with `-file` set to this directory's absolute path, enable god and
notarget, then `set_view` angle 90, pitch 45 at the start. With `freeze_time {frozen: true, frameTime: true}`, two
screenshots 2 s apart are byte-identical; with `frameTime: false` they differ on the floor. Check
both the software and OpenGL renderers: they time warps differently.
