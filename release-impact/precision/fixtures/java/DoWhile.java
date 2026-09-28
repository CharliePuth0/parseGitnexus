public class DoWhile {

    public int poll(int limit, int seed) {
        int ticks = 0;
        int value = seed;
        do {
            if (value > limit) {
                value = 0;
            }
            ticks = ticks + 1;
            value = value + 1;
        } while (value < limit);
        return ticks;
    }
}
