package main

func multiReturn(n int) (int, error) {
	val, err := load(n)
	if err != nil {
		return 0, err
	}
	val = val * 2
	return val, nil
}

func load(n int) (int, error) {
	return n, nil
}
