public class ForContinue {

    public int sumEven(int[] values) {
        int sum = 0;
        for (int i = 0; i < values.length; i++) {
            if (values[i] % 2 != 0) {
                continue;
            }
            sum = sum + values[i];
        }
        return sum;
    }
}
