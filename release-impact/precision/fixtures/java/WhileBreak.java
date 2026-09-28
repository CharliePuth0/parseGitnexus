public class WhileBreak {

    public int find(int[] values, int wanted) {
        int i = 0;
        while (i < values.length) {
            if (values[i] == wanted) {
                break;
            }
            i = i + 1;
        }
        return i;
    }
}
